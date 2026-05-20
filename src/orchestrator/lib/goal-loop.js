'use strict';

/**
 * goal-loop.js — orchestration core for the OpenClaw Frontier Stack.
 *
 * This module is the shared library that the orchestration harness
 * (`scripts/orchestrate.js`) and the engineer CLI (`bin/openclaw`) build on.
 * It owns the `/goal` schema, lane normalization, dispatch via the blackboard
 * ledger, polling for results, and the mock-agent harness used in tests and
 * for the no-agents-attached default workflow.
 *
 * The orchestrator never executes an agent in-process. "Dispatch" is a
 * `task-claim` written to the blackboard ledger by the operator-owned
 * `orchestrator` agent. A live agent role is expected to observe the ledger
 * and answer with a `result` record. In mock mode this module synthesizes
 * those result records itself so the loop closes without a live bus.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { createLedger, BlackboardValidationError } = require('../../blackboard/lib/ledger.js');
const { TaskFlowRuntime, TaskFlowError } = require('../../taskflow/lib/taskflow.js');
const { PATTERNS } = require('../../../lib/coordination/index.js');
const { estimateCallCost } = require('../../../lib/cost/index.js');
const hookDispatcher = require('../../../lib/hooks/dispatcher.js');
const hookConsent = require('../../../lib/hooks/consent.js');
const goalState = require('./goal-state.js');

// Repo root, computed once. The goal-loop is invoked from multiple cwds
// (test temp dirs, the orchestration harness, the CLI), so we anchor the
// hook config + allowlist to the repo so the dispatcher uses the same
// surface regardless of cwd.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOKS_CONFIG_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const HOOK_ALLOWLIST_PATH = path.join(REPO_ROOT, 'release-gate', 'hook-allowlist.json');

const VALID_PATTERNS = new Set(['fan-out', 'fan-in', 'chain', 'voting']);

const GOAL_SCHEMA = 'openclaw-frontier.goal.v1';
const TRACE_SCHEMA = 'openclaw-frontier.orchestration-trace.v1';
const ORCHESTRATOR_AGENT = 'orchestrator';

const ALLOWED_AGENT_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ALLOWED_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

class GoalValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GoalValidationError';
    this.code = 'GOAL_VALIDATION';
    this.details = details;
  }
}

function shortId() {
  return crypto.randomUUID
    ? crypto.randomUUID().split('-')[0]
    : crypto.randomBytes(4).toString('hex');
}

function sha256OfJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toSimpleAgentId(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GoalValidationError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim().toLowerCase().replace(/[^A-Za-z0-9_-]+/g, '_');
  if (!ALLOWED_AGENT_RE.test(normalized)) {
    throw new GoalValidationError(`${label} cannot be reduced to a simple agent id`, { value });
  }
  return normalized;
}

function toSimpleTaskId(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GoalValidationError(`${label} must be a non-empty string`);
  }
  const normalized = value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!ALLOWED_TASK_ID_RE.test(normalized)) {
    throw new GoalValidationError(`${label} cannot be reduced to a simple task id`, { value });
  }
  return normalized.slice(0, 96);
}

/**
 * Subject prefix the orchestrator/agent use to publish per-call cost
 * telemetry as `fact` records. The blackboard does not have a first-class
 * `usage` field on `result` records, so we publish a sibling fact with the
 * model id + raw usage block. Subject shape: `usage:<taskId>`.
 */
const USAGE_FACT_SUBJECT_PREFIX = 'usage:';

function extractUsageFacts(records) {
  const out = [];
  for (const r of records || []) {
    if (r.kind !== 'fact') continue;
    if (typeof r.subject !== 'string') continue;
    if (!r.subject.startsWith(USAGE_FACT_SUBJECT_PREFIX)) continue;
    const taskId = r.subject.slice(USAGE_FACT_SUBJECT_PREFIX.length);
    const value = r.value || {};
    out.push({
      ts: r.ts,
      taskId,
      agent: r.agent,
      model: value.model || null,
      usage: value.usage || {},
      raw: r,
    });
  }
  return out;
}

function applyUsageFactsToState(state, usageFacts) {
  if (!state || !Array.isArray(usageFacts)) return state;
  const known = new Set((state.costEvents || []).map((e) => e.id));
  state.costEvents = state.costEvents || [];
  for (const fact of usageFacts) {
    const id = fact.raw && fact.raw.id;
    if (id && known.has(id)) continue;
    const est = estimateCallCost({ model: fact.model, usage: fact.usage });
    state.costEvents.push({
      id,
      ts: fact.ts,
      taskId: fact.taskId,
      agent: fact.agent,
      model: fact.model,
      usd: est.usd,
      usage: est.usage,
      modelResolved: est.modelResolved,
    });
    goalState.applyCallCost(state, est, { taskId: fact.taskId });
    if (id) known.add(id);
  }
  return state;
}

function emitProgress(onProgress, event) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(event); } catch (_) { /* progress is best-effort */ }
}

/**
 * Fire one event-hook lifecycle event and return the dispatcher result.
 *
 * The dispatcher is a pure module so we resolve config + allowlist lazily
 * here and cache nothing — operator-edited hook configs take effect on
 * the next dispatch. If either file is missing or unparseable, we return
 * a `continue` decision with empty hooks so the goal loop is never gated
 * on hook infrastructure being present.
 *
 * The result also flows through `onProgress` so the CLI/operator can see
 * which hooks fired, which were blocked, and why. Blocked decisions surface
 * as a separate `event-hook-block` progress event so the operator can
 * react immediately.
 */
async function runEventHook(eventName, payload, { onProgress, hooks = {} } = {}) {
  const configPath = hooks.configPath || HOOKS_CONFIG_PATH;
  const allowlistPath = hooks.allowlistPath || HOOK_ALLOWLIST_PATH;
  let result;
  try {
    result = await hookDispatcher.dispatch(eventName, payload, {
      configPath,
      allowlistPath,
      cwd: REPO_ROOT,
      timeoutMs: hooks.timeoutMs || 5000,
      onWarn: (warning) => emitProgress(onProgress, { kind: 'event-hook-warning', ...warning }),
    });
  } catch (err) {
    emitProgress(onProgress, { kind: 'event-hook-error', eventName, error: String(err.message || err) });
    return { decision: 'continue', reason: null, context: [], hooks: [], error: String(err.message || err) };
  }
  if (result.decision === 'block') {
    emitProgress(onProgress, {
      kind: 'event-hook-block',
      eventName,
      hookId: result.blockerHookId,
      reason: result.reason,
    });
  } else if (result.hooks && result.hooks.length > 0) {
    emitProgress(onProgress, {
      kind: 'event-hook-fired',
      eventName,
      hookCount: result.hooks.length,
      contextCount: result.context.length,
    });
  }
  return result;
}

/**
 * Parse a lane's `failure_mode`. Returns `{ kind, retries }` where `kind` is
 * one of:
 *   - 'abort'    — default; an `ok: false` result fails the whole goal
 *   - 'continue' — record the failure but proceed to other lanes / synthesis
 *   - 'retry'    — re-dispatch the lane up to `retries` additional times
 *
 * Accepts a literal `'abort' | 'continue'` string, a `'retry-N'` string
 * (e.g. `'retry-3'`), or an object `{ kind, retries }`. Unspecified defaults
 * to `{ kind: 'abort', retries: 0 }` for backwards compatibility.
 */
function normalizeFailureMode(raw, label = 'lane') {
  if (raw == null || raw === '') return { kind: 'abort', retries: 0, fallbackRole: null };
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'abort') return { kind: 'abort', retries: 0, fallbackRole: null };
    if (trimmed === 'continue') return { kind: 'continue', retries: 0, fallbackRole: null };
    const retryMatch = /^retry-(\d+)$/.exec(trimmed);
    if (retryMatch) {
      const n = Math.max(1, Math.min(10, parseInt(retryMatch[1], 10)));
      return { kind: 'retry', retries: n, fallbackRole: null };
    }
    throw new GoalValidationError(`${label}.failure_mode must be 'abort' | 'continue' | 'retry-N' (got: ${raw})`);
  }
  if (raw && typeof raw === 'object') {
    // Accept both legacy `{ kind, retries }` and new `{ onFailure, retries,
    // fallbackRole }` (the failurePolicy shape).
    const kindRaw = raw.kind || raw.onFailure || 'abort';
    const kind = String(kindRaw).toLowerCase();
    if (kind === 'abort' || kind === 'continue') {
      return { kind, retries: 0, fallbackRole: null };
    }
    if (kind === 'retry') {
      const n = Math.max(1, Math.min(10, Number(raw.retries) || 1));
      return { kind: 'retry', retries: n, fallbackRole: null };
    }
    if (kind === 'fallback') {
      const fallbackRole = raw.fallbackRole || raw.fallback_role || null;
      if (!fallbackRole) {
        throw new GoalValidationError(`${label}.failurePolicy.fallbackRole is required when onFailure='fallback'`);
      }
      const n = Math.max(0, Math.min(10, Number(raw.retries) || 0));
      return { kind: 'fallback', retries: n, fallbackRole: toSimpleAgentId(fallbackRole, `${label}.fallbackRole`) };
    }
    throw new GoalValidationError(`${label}.failure_mode.kind must be 'abort' | 'continue' | 'retry' | 'fallback' (got: ${kindRaw})`);
  }
  throw new GoalValidationError(`${label}.failure_mode must be a string or object`);
}

/**
 * Validate and normalize a goal record into the canonical orchestrator shape.
 *
 * Goals may come from a JSON file, the CLI prompt path (`goalFromPrompt`),
 * or another upstream surface. Required fields after normalization:
 *
 *   - id (simple task id)
 *   - title (string, 1..200)
 *   - lanes (array of { name, role, summary, expects? })
 *
 * Optional fields preserved: source, definitionOfDone, cadence, green, red,
 * status, owner.
 */
function normalizeGoal(input, { idHint } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoalValidationError('goal must be an object');
  }
  const idRaw = input.id || idHint || `goal-${shortId()}`;
  const id = toSimpleTaskId(idRaw, 'goal.id');

  const title = String(input.title || '').trim();
  if (!title || title.length > 200) {
    throw new GoalValidationError('goal.title must be a 1..200 character string');
  }

  const lanesIn = Array.isArray(input.lanes) ? input.lanes : [];
  if (lanesIn.length === 0) {
    throw new GoalValidationError('goal.lanes must contain at least one lane');
  }
  const seen = new Set();
  const lanes = lanesIn.map((lane, index) => {
    if (!lane || typeof lane !== 'object') {
      throw new GoalValidationError(`goal.lanes[${index}] must be an object`);
    }
    const name = toSimpleTaskId(lane.name || lane.id || `lane-${index + 1}`, `goal.lanes[${index}].name`);
    if (seen.has(name)) {
      throw new GoalValidationError(`goal.lanes[${index}].name is a duplicate: ${name}`);
    }
    seen.add(name);
    // Lanes that drive a coordination pattern (fan-out/fan-in/chain/voting)
    // do NOT require a `role` because they expand into multiple per-task roles.
    // For backwards compatibility we still default the lane-level role to
    // 'orchestrator' so the surface shape (name/role/summary) stays valid.
    const patternRaw = typeof lane.pattern === 'string' ? lane.pattern.trim() : '';
    let role;
    if (patternRaw) {
      if (!VALID_PATTERNS.has(patternRaw)) {
        throw new GoalValidationError(`goal.lanes[${index}].pattern must be one of fan-out|fan-in|chain|voting`, { value: patternRaw });
      }
      role = toSimpleAgentId(lane.role || lane.owner || 'orchestrator', `goal.lanes[${index}].role`);
    } else {
      role = toSimpleAgentId(lane.role || lane.owner || 'builder', `goal.lanes[${index}].role`);
    }
    const summary = String(lane.summary || lane.description || `Lane ${name}`).trim().slice(0, 500);
    const expects = Array.isArray(lane.expects) ? lane.expects.map(String).slice(0, 16) : [];
    const failureMode = normalizeFailureMode(
      lane.failurePolicy || lane.failure_policy || lane.failure_mode || lane.failureMode,
      `goal.lanes[${index}]`
    );
    const normalized = { name, role, summary, expects, failureMode };
    if (patternRaw) {
      normalized.pattern = patternRaw;
      // Pattern-specific payloads. We preserve the raw shape and validate at
      // runPatternLane time so coordination modules own their own contracts.
      if (patternRaw === 'fan-out' || patternRaw === 'chain') {
        const key = patternRaw === 'fan-out' ? 'tasks' : 'steps';
        const items = Array.isArray(lane[key]) ? lane[key] : [];
        if (items.length === 0) throw new GoalValidationError(`goal.lanes[${index}].${key} must be a non-empty array for pattern ${patternRaw}`);
        normalized[key] = items.map((t, i) => ({
          id: toSimpleTaskId(t.id || `${name}-${i + 1}`, `goal.lanes[${index}].${key}[${i}].id`),
          role: toSimpleAgentId(t.role || 'builder', `goal.lanes[${index}].${key}[${i}].role`),
          summary: String(t.summary || t.description || t.id || `${key} ${i + 1}`).trim().slice(0, 500),
          expects: Array.isArray(t.expects) ? t.expects.map(String).slice(0, 16) : [],
        }));
      } else if (patternRaw === 'fan-in') {
        const sources = Array.isArray(lane.sourceTaskIds) ? lane.sourceTaskIds : [];
        if (sources.length === 0) throw new GoalValidationError(`goal.lanes[${index}].sourceTaskIds must be a non-empty array for fan-in`);
        normalized.sourceTaskIds = sources.map((s) => String(s).trim());
        const joiner = lane.joiner || {};
        if (!joiner.id || !joiner.role) throw new GoalValidationError(`goal.lanes[${index}].joiner must have { id, role } for fan-in`);
        normalized.joiner = {
          id: toSimpleTaskId(joiner.id, `goal.lanes[${index}].joiner.id`),
          role: toSimpleAgentId(joiner.role, `goal.lanes[${index}].joiner.role`),
          summary: String(joiner.summary || `join ${name}`).slice(0, 500),
        };
      } else if (patternRaw === 'voting') {
        const voters = Array.isArray(lane.voters) ? lane.voters : [];
        if (voters.length === 0) throw new GoalValidationError(`goal.lanes[${index}].voters must be a non-empty array for voting`);
        normalized.voters = voters.map((v, i) => ({
          id: toSimpleTaskId(v.id || `voter-${i + 1}`, `goal.lanes[${index}].voters[${i}].id`),
          role: toSimpleAgentId(v.role || 'reviewer', `goal.lanes[${index}].voters[${i}].role`),
        }));
        normalized.decision = String(lane.decision || lane.summary || `decision for ${name}`).slice(0, 500);
        if (lane.quorum != null) normalized.quorum = Number(lane.quorum);
        if (lane.threshold != null) normalized.threshold = Number(lane.threshold);
      }
    }
    return normalized;
  });

  const cadence = input.cadence && typeof input.cadence === 'object'
    ? {
        operatorUpdateMinutes: Number(input.cadence.operatorUpdateMinutes) || 30,
        channel: String(input.cadence.channel || 'operator-chat').slice(0, 64),
      }
    : { operatorUpdateMinutes: 30, channel: 'operator-chat' };

  const subGoalsRaw = Array.isArray(input.subGoals) ? input.subGoals : [];
  const subGoals = subGoalsRaw.map((sg, i) => normalizeSubGoalSpec(sg, i, id));

  return {
    schema: GOAL_SCHEMA,
    id,
    title,
    status: String(input.status || 'active').slice(0, 32),
    owner: toSimpleAgentId(input.owner || ORCHESTRATOR_AGENT, 'goal.owner'),
    source: String(input.source || 'unknown').slice(0, 200),
    definitionOfDone: String(input.definitionOfDone || `All lanes for ${id} return GREEN receipts.`).slice(0, 1000),
    cadence,
    lanes,
    subGoals,
    green: Array.isArray(input.green) ? input.green.map((s) => String(s).slice(0, 500)) : [],
    red: Array.isArray(input.red) ? input.red.map((s) => String(s).slice(0, 500)) : [],
  };
}

/**
 * Normalize one sub-goal spec. A sub-goal spec is itself a (smaller) goal
 * record: `{ id?, title, lanes, ... }`. We re-use `normalizeGoal` so the
 * recursive shape is the same. The sub id is forced to a `<parent>.<index>`
 * scheme so two sub-goals from the same parent cannot collide.
 */
function normalizeSubGoalSpec(spec, index, parentId) {
  if (!spec || typeof spec !== 'object') {
    throw new GoalValidationError(`goal.subGoals[${index}] must be an object`);
  }
  const idHint = spec.id || `${parentId}.sub-${index + 1}`;
  return normalizeGoal({ ...spec, id: idHint, source: spec.source || `subgoal-of:${parentId}` }, { idHint });
}

/**
 * Build a goal record directly from a freeform prompt the CLI received.
 *
 * The CLI is the lowest-friction surface: the operator types a sentence and we
 * decompose into a default lane plan. This default plan is intentionally
 * conservative and mirrors the demo goal-loop shape (implementation, docs,
 * verification, release, final-approval). Operators who want a non-standard
 * lane plan should provide a goal file.
 */
function goalFromPrompt(prompt, { pattern = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new GoalValidationError('goal prompt must be a non-empty string');
  const slug = toSimpleTaskId(text.slice(0, 60), 'goal.id');
  const id = `goal-${slug}-${shortId()}`;
  const lanes = pattern ? patternLanePlan(pattern, { goalId: id }) : defaultLanePlan();
  return normalizeGoal({
    id,
    title: text.slice(0, 200),
    source: pattern ? `cli-prompt:${pattern}` : 'cli-prompt',
    lanes,
  });
}

/**
 * When the operator passes --pattern, swap the default lane plan for a one-
 * lane goal that exercises the requested coordination pattern. The synthesized
 * task plan is intentionally small (3 tasks / steps / voters) so the CLI flow
 * exercises every code path in mock-agents mode.
 */
function patternLanePlan(pattern, { goalId = null } = {}) {
  if (pattern === 'fan-out') {
    return [{
      name: 'fan-out-lane',
      pattern: 'fan-out',
      summary: 'demo fan-out over 3 independent reviewers',
      tasks: [
        { id: 'reviewer-a', role: 'reviewer', summary: 'review file a' },
        { id: 'reviewer-b', role: 'reviewer', summary: 'review file b' },
        { id: 'reviewer-c', role: 'reviewer', summary: 'review file c' },
      ],
    }];
  }
  if (pattern === 'chain') {
    return [{
      name: 'chain-lane',
      pattern: 'chain',
      summary: 'demo chain: research -> spec -> build',
      steps: [
        { id: 'research', role: 'researcher', summary: 'gather context' },
        { id: 'spec', role: 'architect', summary: 'draft spec' },
        { id: 'build', role: 'builder', summary: 'implement' },
      ],
    }];
  }
  if (pattern === 'voting') {
    return [{
      name: 'voting-lane',
      pattern: 'voting',
      summary: 'demo cross-role vote',
      decision: 'Ship the demo build?',
      voters: [
        { id: 'sec', role: 'sentinel' },
        { id: 'rev', role: 'reviewer' },
        { id: 'arch', role: 'architect' },
      ],
      quorum: 2,
      threshold: 2 / 3,
    }];
  }
  if (pattern === 'fan-in') {
    // fan-in needs upstream taskIds that are *already* on the ledger. In CLI
    // demo mode we pair it with a small fan-out upstream, then a fan-in
    // joiner over those taskIds. The upstream task ids must match the shape
    // that fan-out writes: `${goalId}.${task.id}`.
    return [
      {
        name: 'fan-out-upstream',
        pattern: 'fan-out',
        summary: 'demo fan-out feeding the joiner',
        tasks: [
          { id: 'u1', role: 'reviewer', summary: 'upstream 1' },
          { id: 'u2', role: 'reviewer', summary: 'upstream 2' },
        ],
      },
      {
        name: 'fan-in-lane',
        pattern: 'fan-in',
        summary: 'demo joiner over the fan-out outputs',
        sourceTaskIds: [`${goalId}.u1`, `${goalId}.u2`],
        joiner: { id: 'synthesize', role: 'architect', summary: 'merge upstream verdicts' },
      },
    ];
  }
  throw new GoalValidationError(`unknown --pattern: ${pattern}`);
}

function defaultLanePlan() {
  return [
    { name: 'implementation', role: 'builder', summary: 'Author the change set described by the goal.', expects: ['patch', 'tests-run'] },
    { name: 'documentation', role: 'docs', summary: 'Document the change in operator-facing surface.', expects: ['doc-diff'] },
    { name: 'verification', role: 'verifier', summary: 'Run smoke/verify scripts and capture receipts.', expects: ['verify-report'] },
    { name: 'release-packaging', role: 'release_manager', summary: 'Bundle the artifact for release review.', expects: ['release-manifest'] },
    { name: 'final-approval', role: 'sentinel', summary: 'Gate the release on Sentinel policy.', expects: ['sentinel-decision'] },
  ];
}

/**
 * Append a task-claim per lane to the blackboard ledger, simulating dispatch.
 *
 * The orchestrator is the one writing the claim — the live agent will pick
 * the task off the bus and respond with a result record. We write claims on
 * behalf of the orchestrator agent (`orchestrator`) so that the live agent
 * sees an authoritative record of who delegated the lane.
 */
function dispatchLanes(ledger, goal, { skipExisting = null } = {}) {
  // skipExisting: a Set of laneNames whose claims are already on the ledger
  // (loaded from a resumed goal state). We only emit task-claims for lanes not
  // in the set. The returned `claims` array includes both freshly-emitted
  // claims AND the pre-existing claims from skipExisting (so the caller sees
  // a stable shape regardless of resume).
  const claims = [];
  for (const lane of goal.lanes) {
    const taskId = `${goal.id}.${lane.name}`;
    if (skipExisting && skipExisting.has(lane.name)) {
      const existing = findExistingClaim(ledger, taskId);
      if (existing) {
        claims.push({
          laneName: lane.name,
          role: lane.role,
          taskId,
          claimId: existing.id,
          claimedAt: existing.ts,
          resumed: true,
        });
        continue;
      }
      // Fall through and re-dispatch if the claim is missing.
    }
    const summary = `[${goal.id}] ${lane.summary}`.slice(0, 500);
    const claim = ledger.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary,
      forRole: lane.role,
    });
    claims.push({
      laneName: lane.name,
      role: lane.role,
      taskId,
      claimId: claim.id,
      claimedAt: claim.ts,
    });
  }
  return claims;
}

function findExistingClaim(ledger, taskId) {
  const records = ledger.readRecords();
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.kind === 'task-claim' && r.taskId === taskId) return r;
  }
  return null;
}

function existingClaimedLaneNames(ledger, goal) {
  const records = ledger.readRecords();
  const out = new Set();
  for (const lane of goal.lanes) {
    const taskId = `${goal.id}.${lane.name}`;
    if (records.some((r) => r.kind === 'task-claim' && r.taskId === taskId)) {
      out.add(lane.name);
    }
  }
  return out;
}

/**
 * Block (async) waiting for result records for every dispatched task.
 *
 * Re-reads the ledger snapshot every `pollIntervalMs` ms until either all
 * tasks have a matching result or `maxWaitMs` elapses. The function uses
 * `setTimeout` not `Atomics.wait` so the event loop stays live — required
 * for in-process tests that run a mock model server in the same Node
 * process as the harness.
 *
 * When `onProgress` is a function, it receives a `{ kind: 'result-received',
 * taskId, ok, summary, ts, agent }` event the first time a result is
 * observed for each claim.
 *
 * Returns `{ done, pending, results }` where:
 *   - `done` is the list of `{ taskId, ok, summary, artifacts, ts, agent }`
 *     for tasks that completed
 *   - `pending` is the list of taskIds still waiting
 *   - `results` is the raw result records from the ledger snapshot
 */
async function pollForResults(ledger, claims, {
  maxWaitMs = 300000,
  pollIntervalMs = 250,
  now = Date.now,
  onProgress = null,
} = {}) {
  const wantedIds = new Set(claims.map((claim) => claim.taskId));
  const seen = new Set();
  const started = now();
  while (true) {
    const snapshot = ledger.snapshot();
    const done = [];
    const pending = [];
    for (const claim of claims) {
      const result = snapshot.results.find((r) => r.taskId === claim.taskId);
      if (result) {
        if (!seen.has(claim.taskId)) {
          seen.add(claim.taskId);
          emitProgress(onProgress, {
            kind: 'result-received',
            laneName: claim.laneName,
            taskId: claim.taskId,
            ok: Boolean(result.ok),
            agent: result.agent,
            summary: result.summary,
            ts: result.ts,
          });
        }
        done.push({
          laneName: claim.laneName,
          taskId: claim.taskId,
          ok: Boolean(result.ok),
          summary: result.summary,
          artifacts: result.artifacts || [],
          ts: result.ts,
          agent: result.agent,
        });
      } else {
        pending.push(claim.taskId);
      }
    }
    if (pending.length === 0) {
      return { done, pending: [], results: snapshot.results.filter((r) => wantedIds.has(r.taskId)) };
    }
    if (now() - started >= maxWaitMs) {
      return { done, pending, results: snapshot.results.filter((r) => wantedIds.has(r.taskId)) };
    }
    await sleepAsync(pollIntervalMs);
  }
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function laneRoleFor(lanes, laneName) {
  const lane = (lanes || []).find((l) => l && l.name === laneName);
  return (lane && lane.role) || 'unknown';
}

// Legacy sync sleep retained for any third-party caller that imports it. The
// orchestrator itself no longer uses it.
function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

/**
 * In mock mode the orchestrator plays the role of every agent and writes a
 * synthesized result record per lane immediately after dispatch. This lets the
 * harness produce a complete trace without any live agent on the other side
 * of the blackboard.
 *
 * Each mock result is deterministic given the goal and lane. We compute a
 * stable receipt path and include a sha256 over the synthesized body so the
 * trace can still be hashed and verified the same way a real receipt would
 * be.
 */
function synthesizeMockResults(ledger, goal, claims, { strategy = 'all-ok' } = {}) {
  const synthesized = [];
  for (const claim of claims) {
    const lane = goal.lanes.find((l) => l.name === claim.laneName);
    const receiptRel = `release-gate/orchestration/${goal.id}/${claim.laneName}.receipt.json`;
    const verdict = strategy === 'all-ok' ? 'GREEN'
      : strategy === 'last-red' && claim === claims[claims.length - 1] ? 'RED'
      : 'GREEN';
    const body = {
      schema: 'openclaw-frontier.lane-receipt.v1',
      goalId: goal.id,
      lane: claim.laneName,
      role: claim.role,
      verdict,
      summary: `mock ${claim.role} synthesized result for lane ${claim.laneName}: ${lane.summary}`,
      expects: lane.expects,
      artifacts: [],
      sha256OfBody: null,
    };
    body.sha256OfBody = sha256OfJson({ goalId: body.goalId, lane: body.lane, role: body.role, verdict: body.verdict, summary: body.summary, expects: body.expects });
    const record = ledger.recordResult({
      agent: claim.role,
      taskId: claim.taskId,
      ok: verdict === 'GREEN',
      summary: body.summary.slice(0, 1000),
      artifacts: [],
    });
    synthesized.push({
      laneName: claim.laneName,
      taskId: claim.taskId,
      ok: verdict === 'GREEN',
      verdict,
      receipt: receiptRel,
      resultId: record.id,
      bodySha256: body.sha256OfBody,
    });
  }
  return synthesized;
}

/**
 * Combine dispatch claims and observed results into a final synthesis trace.
 *
 * Every lane has one of three states:
 *   - DONE  → result.ok === true
 *   - FAILED → result.ok === false
 *   - PENDING → no result observed in `pollForResults` budget
 *
 * The synthesized verdict is GREEN only when every lane is DONE.
 */
function synthesize(goal, claims, pollOutcome) {
  const lanes = goal.lanes.map((lane) => {
    const claim = claims.find((c) => c.laneName === lane.name);
    const done = pollOutcome.done.find((d) => d.laneName === lane.name);
    const pending = pollOutcome.pending.includes(claim && claim.taskId);
    let status = 'pending';
    if (done) status = done.ok ? 'done' : 'failed';
    return {
      name: lane.name,
      role: lane.role,
      taskId: claim ? claim.taskId : null,
      status,
      ok: done ? done.ok : false,
      summary: done ? done.summary : (pending ? 'no result before max-wait timeout' : 'not dispatched'),
      artifacts: done ? done.artifacts : [],
      resultAgent: done ? done.agent : null,
      resultTs: done ? done.ts : null,
    };
  });
  const overallOk = lanes.every((lane) => lane.status === 'done');
  const greenLanes = lanes.filter((l) => l.status === 'done').map((l) => l.name);
  const redLanes = lanes.filter((l) => l.status !== 'done').map((l) => `${l.name}:${l.status}`);
  return {
    schema: TRACE_SCHEMA,
    goalId: goal.id,
    title: goal.title,
    ok: overallOk,
    generatedAt: new Date().toISOString(),
    lanes,
    green: greenLanes,
    red: redLanes,
    definitionOfDone: goal.definitionOfDone,
  };
}

/**
 * Build a TaskFlowRuntime mirror of the dispatched lanes for in-memory
 * inspection / tests. The harness emits this trace alongside the
 * blackboard-driven trace so callers can verify either side independently.
 */
function buildTaskflowMirror(goal, claims, pollOutcome) {
  const runtime = new TaskFlowRuntime();
  for (const lane of goal.lanes) {
    const claim = claims.find((c) => c.laneName === lane.name);
    if (!claim) continue;
    try {
      runtime.createTask({
        taskId: claim.taskId,
        title: lane.summary,
        owner: ORCHESTRATOR_AGENT,
        priority: 'normal',
        inputs: { goalId: goal.id, laneName: lane.name, role: lane.role },
        dependsOn: [],
      });
      runtime.claimTask({ taskId: claim.taskId, agent: lane.role });
      const done = pollOutcome.done.find((d) => d.laneName === lane.name);
      if (done) {
        runtime.completeTask({
          taskId: claim.taskId,
          agent: lane.role,
          status: done.ok ? 'ok' : 'failed',
          summary: done.summary,
          artifacts: done.artifacts,
        });
      } else {
        runtime.waitTask({ taskId: claim.taskId, agent: lane.role, reason: 'no result before max-wait timeout' });
      }
    } catch (err) {
      // Validation errors here mean the lane plan would not pass the strict
      // TaskFlow schema. Surface them but do not fail the entire trace; the
      // primary state-of-record is the blackboard ledger.
      runtime.append('task-validation-warning', {
        taskId: claim.taskId,
        message: String(err.message || err),
      });
    }
  }
  return runtime.snapshot();
}

/**
 * Drive a single lane through one of the coordination patterns. The lane is
 * NOT dispatched as a single task — instead it expands into the pattern's own
 * task plan. The function returns a synthetic lane-level result so the outer
 * synthesis loop can treat pattern lanes uniformly with simple lanes.
 *
 * Mock mode: each coordinator accepts pre-baked mock results so the patterns
 * close in-process without a live bus. We synthesize those mock entries from
 * the lane's task plan.
 */
async function runPatternLane({ goalId, lane, ledger, taskflow, maxWaitMs, pollIntervalMs, mockAgents, now }) {
  const fn = PATTERNS[lane.pattern];
  if (!fn) throw new GoalValidationError(`unknown lane pattern: ${lane.pattern}`);
  const baseOpts = { goalId, ledger, taskflow, timeoutMs: maxWaitMs, pollIntervalMs, now };
  if (lane.pattern === 'fan-out') {
    const mockResults = mockAgents ? lane.tasks.map((t) => ({
      taskId: `${goalId}.${t.id}`,
      ok: true,
      summary: `mock fan-out ${t.role} for ${t.id}: ${t.summary}`.slice(0, 1000),
    })) : null;
    return { lane, patternResult: await fn({ ...baseOpts, tasks: lane.tasks, mockResults }) };
  }
  if (lane.pattern === 'fan-in') {
    const mockJoinerResult = mockAgents ? {
      ok: true,
      summary: `mock fan-in ${lane.joiner.role} joined ${lane.sourceTaskIds.length} upstreams`.slice(0, 1000),
    } : null;
    return { lane, patternResult: await fn({ ...baseOpts, sourceTaskIds: lane.sourceTaskIds, joiner: lane.joiner, mockJoinerResult }) };
  }
  if (lane.pattern === 'chain') {
    const mockResults = mockAgents ? lane.steps.map((s) => ({
      stepId: s.id,
      ok: true,
      summary: `mock chain step ${s.id} (${s.role}): ${s.summary}`.slice(0, 1000),
    })) : null;
    return { lane, patternResult: await fn({ ...baseOpts, steps: lane.steps, mockResults }) };
  }
  if (lane.pattern === 'voting') {
    const mockVotes = mockAgents ? lane.voters.map((v) => ({
      voterId: v.id,
      ok: true,
      summary: `mock approve from ${v.role} (${v.id})`,
    })) : null;
    return { lane, patternResult: await fn({
      ...baseOpts,
      decision: lane.decision || lane.summary,
      voters: lane.voters,
      quorum: lane.quorum,
      threshold: lane.threshold,
      mockVotes,
    }) };
  }
  throw new GoalValidationError(`pattern handler missing: ${lane.pattern}`);
}

/**
 * Reduce a pattern coordinator's return to the lane-level shape used by the
 * outer synthesis. Pattern lanes do not have a single owning task; we summarize
 * their internal trace into one row in the lanes array.
 */
function summarizePatternLane(lane, patternResult) {
  if (lane.pattern === 'fan-out') {
    const status = patternResult.ok ? 'done' : (patternResult.timedOut.length > 0 ? 'pending' : 'failed');
    return {
      name: lane.name,
      role: lane.role,
      pattern: 'fan-out',
      taskId: null,
      status,
      ok: patternResult.ok,
      summary: `fan-out: ${patternResult.completed.length} ok / ${patternResult.failed.length} fail / ${patternResult.timedOut.length} timed-out (of ${patternResult.claims.length})`,
      artifacts: [],
      patternTrace: patternResult,
    };
  }
  if (lane.pattern === 'fan-in') {
    const status = patternResult.ok ? 'done' : (patternResult.upstream.missing.length > 0 ? 'pending' : 'failed');
    return {
      name: lane.name,
      role: lane.role,
      pattern: 'fan-in',
      taskId: patternResult.joiner.taskId,
      status,
      ok: patternResult.ok,
      summary: `fan-in: ${patternResult.upstream.complete.length} upstream collected; joiner=${patternResult.joiner.dispatched ? (patternResult.joiner.result && patternResult.joiner.result.ok ? 'ok' : 'not-ok') : 'not-dispatched'}`,
      artifacts: patternResult.joiner.result ? (patternResult.joiner.result.artifacts || []) : [],
      patternTrace: patternResult,
    };
  }
  if (lane.pattern === 'chain') {
    const status = patternResult.ok ? 'done' : 'failed';
    return {
      name: lane.name,
      role: lane.role,
      pattern: 'chain',
      taskId: null,
      status,
      ok: patternResult.ok,
      summary: `chain: ${patternResult.completedCount}/${patternResult.steps.length} steps done`,
      artifacts: [],
      patternTrace: patternResult,
    };
  }
  if (lane.pattern === 'voting') {
    return {
      name: lane.name,
      role: lane.role,
      pattern: 'voting',
      taskId: null,
      status: patternResult.ok ? 'done' : 'failed',
      ok: patternResult.ok,
      summary: `voting: ${patternResult.tally.approve} approve / ${patternResult.tally.reject} reject (quorum ${patternResult.quorumMet ? 'met' : 'not met'}, threshold ${patternResult.thresholdMet ? 'met' : 'not met'}); verdict=${patternResult.verdict}`,
      artifacts: [],
      patternTrace: patternResult,
    };
  }
  return {
    name: lane.name,
    role: lane.role,
    pattern: lane.pattern,
    taskId: null,
    status: 'failed',
    ok: false,
    summary: 'unknown pattern',
    artifacts: [],
    patternTrace: patternResult,
  };
}

/**
 * The orchestration harness entrypoint. Inputs:
 *
 *   - goal: a normalized goal record (or raw input — we'll normalize)
 *   - blackboardPath: absolute path to a blackboard ledger jsonl file
 *   - maxWaitMs: budget for waiting on live agents (default 5min)
 *   - mockAgents: when true, synthesize results immediately after dispatch
 *   - dryRun: when true, do not write to the ledger at all; return a
 *     simulated trace describing what would have happened
 */
async function runGoalLoop({
  goal,
  blackboardPath,
  maxWaitMs = 300000,
  mockAgents = false,
  dryRun = false,
  pollIntervalMs = 200,
  now = Date.now,
  // v0.7 additions:
  onProgress = null,
  persistState = true,
  goalsDir = null,
  resume = false,
  templateName = null,
  templateContext = null,
} = {}) {
  // Decide whether we are starting fresh or resuming an existing state file.
  // Resume mode: re-read the prior state, normalize its embedded goal,
  // re-dispatch only the lanes that have not yet been dispatched, then
  // continue polling. The `goal` arg in resume mode only needs `goal.id`.
  let prior = null;
  let normalized;
  if (resume) {
    const dir = goalState.resolveGoalsDir({ blackboardPath, override: goalsDir });
    if (!goal || typeof goal !== 'object' || !goal.id) {
      throw new GoalValidationError('runGoalLoop: --resume requires an existing goal id');
    }
    prior = goalState.readState(dir, goal.id);
    normalized = normalizeGoal(prior.goal);
    blackboardPath = blackboardPath || prior.blackboardPath;
    mockAgents = prior.options && typeof prior.options.mockAgents === 'boolean' ? prior.options.mockAgents : mockAgents;
    if (prior.status === 'done' || prior.status === 'failed' || prior.status === 'aborted') {
      emitProgress(onProgress, { kind: 'resume-noop', goalId: prior.goalId, status: prior.status });
      return rebuildTraceFromState(prior);
    }
    emitProgress(onProgress, { kind: 'resume-start', goalId: prior.goalId, status: prior.status });
  } else {
    normalized = normalizeGoal(goal);
  }

  if (dryRun) {
    return {
      schema: TRACE_SCHEMA,
      goalId: normalized.id,
      title: normalized.title,
      ok: true,
      dryRun: true,
      generatedAt: new Date().toISOString(),
      lanes: normalized.lanes.map((lane) => ({
        name: lane.name,
        role: lane.role,
        pattern: lane.pattern || null,
        taskId: lane.pattern ? null : `${normalized.id}.${lane.name}`,
        status: 'would-dispatch',
        ok: false,
        summary: lane.pattern
          ? `dry-run: would run ${lane.pattern} coordinator for ${lane.name}`
          : 'dry-run: no claim written, no result solicited',
        artifacts: [],
      })),
      green: [],
      red: normalized.lanes.map((l) => `${l.name}:would-dispatch`),
      definitionOfDone: normalized.definitionOfDone,
      mockAgents,
    };
  }

  const ledger = createLedger({ ledgerPath: blackboardPath });
  const dir = persistState ? goalState.resolveGoalsDir({ blackboardPath, override: goalsDir }) : null;

  // State file: either reuse the prior state (resume) or create a new one.
  let state;
  if (prior) {
    state = prior;
    state.status = 'active';
    state.errors = state.errors || [];
  } else {
    state = goalState.newState({
      goal: normalized,
      blackboardPath,
      options: { mockAgents, dryRun, maxWaitMs, pollIntervalMs, templateName, templateContext },
    });
    if (persistState) {
      goalState.writeStateAtomic(dir, state);
    }
    emitProgress(onProgress, { kind: 'goal-start', goalId: state.goalId, title: state.title, lanes: normalized.lanes.length, mockAgents });
  }

  // Hermes-port goal:start hook. If any allowed hook returns `block` we
  // record an aborted state and emit a synthesized trace without dispatching
  // any lanes — the operator-owned hook is the authority and we honour it.
  const goalStartHook = await runEventHook('goal:start', {
    goalId: state.goalId,
    title: state.title,
    lanes: normalized.lanes.length,
    mockAgents,
  }, { onProgress });
  state.hookContext = state.hookContext || {};
  if (goalStartHook.context && goalStartHook.context.length) state.hookContext['goal:start'] = goalStartHook.context;
  if (goalStartHook.decision === 'block') {
    state.status = 'aborted';
    state.completedAt = new Date().toISOString();
    state.synthesis = {
      ok: false,
      green: [],
      red: normalized.lanes.map((l) => `${l.name}:hook-blocked`),
      aborted: true,
      hookBlocked: true,
      blockerHookId: goalStartHook.blockerHookId,
      reason: goalStartHook.reason,
      generatedAt: state.completedAt,
    };
    if (persistState) goalState.writeStateAtomic(dir, state);
    emitProgress(onProgress, { kind: 'goal-done', goalId: state.goalId, ok: false, status: 'aborted', usd: state.cost.usd, callCount: state.cost.callCount });
    return {
      schema: TRACE_SCHEMA,
      goalId: normalized.id,
      title: normalized.title,
      ok: false,
      generatedAt: state.completedAt,
      lanes: normalized.lanes.map((lane) => ({
        name: lane.name,
        role: lane.role,
        pattern: lane.pattern || null,
        taskId: null,
        status: 'hook-blocked',
        ok: false,
        summary: `goal:start hook ${goalStartHook.blockerHookId} returned block: ${goalStartHook.reason}`,
        artifacts: [],
      })),
      green: [],
      red: normalized.lanes.map((l) => `${l.name}:hook-blocked`),
      definitionOfDone: normalized.definitionOfDone,
      mockAgents,
      aborted: true,
      hookBlocked: { eventName: 'goal:start', hookId: goalStartHook.blockerHookId, reason: goalStartHook.reason },
      cost: state.cost,
    };
  }

  // Split lanes into pattern-driven and simple-dispatch lanes.
  const patternLanes = normalized.lanes.filter((l) => l.pattern);
  const simpleLanes = normalized.lanes.filter((l) => !l.pattern);

  // 1. Run pattern lanes first.
  const patternLaneOutcomes = [];
  const sharedTaskflow = new TaskFlowRuntime();
  const priorPatternByName = new Map((state.patternLanes || []).map((p) => [p.name, p]));
  for (const lane of patternLanes) {
    if (priorPatternByName.has(lane.name) && priorPatternByName.get(lane.name).done) {
      const cached = priorPatternByName.get(lane.name);
      emitProgress(onProgress, { kind: 'pattern-lane-skipped', laneName: lane.name, reason: 'resume-cached' });
      patternLaneOutcomes.push({ lane, patternResult: cached.patternResult });
      continue;
    }
    try {
      emitProgress(onProgress, { kind: 'pattern-lane-start', laneName: lane.name, pattern: lane.pattern });
      const outcome = await runPatternLane({
        goalId: normalized.id,
        lane,
        ledger,
        taskflow: sharedTaskflow,
        maxWaitMs: mockAgents ? 5000 : maxWaitMs,
        pollIntervalMs,
        mockAgents,
        now,
      });
      patternLaneOutcomes.push(outcome);
      state.patternLanes = state.patternLanes || [];
      const existingIdx = state.patternLanes.findIndex((p) => p.name === lane.name);
      const cached = { name: lane.name, pattern: lane.pattern, done: true, ok: Boolean(outcome.patternResult.ok), patternResult: outcome.patternResult };
      if (existingIdx === -1) state.patternLanes.push(cached);
      else state.patternLanes[existingIdx] = cached;
      if (persistState) goalState.writeStateAtomic(dir, state);
      emitProgress(onProgress, { kind: 'pattern-lane-done', laneName: lane.name, ok: Boolean(outcome.patternResult.ok) });
    } catch (err) {
      goalState.recordError(state, err);
      if (persistState) goalState.writeStateAtomic(dir, state);
      if (err instanceof BlackboardValidationError || err instanceof TaskFlowError) {
        throw new GoalValidationError(`pattern lane '${lane.name}' failed: ${err.message}`, err.details || {});
      }
      throw err;
    }
  }

  // 2. Dispatch + collect simple lanes with per-lane failure_mode semantics.
  let simpleOutcome = { claims: [], pollOutcome: { done: [], pending: [], results: [] }, synthesized: [], aborted: false, cancelled: false };
  if (simpleLanes.length > 0) {
    simpleOutcome = await runSimpleLanes({
      ledger,
      normalized,
      simpleLanes,
      mockAgents,
      maxWaitMs,
      pollIntervalMs,
      now,
      onProgress,
      state,
      persistState,
      goalsDir: dir,
      isResume: Boolean(prior),
    });
  }

  // 2b. Run sub-goals (if any) AFTER parent lanes finish. Each sub-goal is
  //     run as a self-contained child goal in the same blackboard, with its
  //     state persisted under `<goalsDir>/sub/<parent>/<sub>.json`. We only
  //     run sub-goals when the parent is not cancelled.
  if (!simpleOutcome.cancelled && Array.isArray(normalized.subGoals) && normalized.subGoals.length > 0) {
    for (const sub of normalized.subGoals) {
      try {
        emitProgress(onProgress, { kind: 'sub-goal-start', parentGoalId: normalized.id, subGoalId: sub.id });
        const subTrace = await runSubGoalInline({
          subGoal: sub,
          parentGoalId: normalized.id,
          parentDir: dir,
          ledger,
          blackboardPath,
          mockAgents,
          onProgress,
        });
        const subStateFile = persistState
          ? goalState.subGoalStatePath(dir, normalized.id, sub.id)
          : null;
        goalState.recordSubGoalResult(state, {
          subGoalId: sub.id,
          template: null,
          status: subTrace.ok ? 'done' : 'failed',
          ok: Boolean(subTrace.ok),
          usd: (subTrace.cost && subTrace.cost.usd) || 0,
          callCount: (subTrace.cost && subTrace.cost.callCount) || 0,
          statePath: subStateFile,
        });
        emitProgress(onProgress, { kind: 'sub-goal-done', parentGoalId: normalized.id, subGoalId: sub.id, ok: Boolean(subTrace.ok) });
        if (persistState) goalState.writeStateAtomic(dir, state);
      } catch (err) {
        goalState.recordError(state, err);
        goalState.recordSubGoalResult(state, {
          subGoalId: sub.id,
          status: 'failed',
          ok: false,
          usd: 0,
          callCount: 0,
          statePath: null,
        });
        if (persistState) goalState.writeStateAtomic(dir, state);
        emitProgress(onProgress, { kind: 'sub-goal-error', parentGoalId: normalized.id, subGoalId: sub.id, error: String(err.message || err) });
      }
    }
  }

  // 3. Read usage facts emitted by agents and fold them into the cost ledger.
  try {
    const allRecords = ledger.readRecords();
    const usageFacts = extractUsageFacts(allRecords).filter((f) => {
      if (typeof f.taskId !== 'string') return false;
      return f.taskId.startsWith(`${normalized.id}.`) || f.taskId === normalized.id;
    });
    applyUsageFactsToState(state, usageFacts);
  } catch (_) {
    // Cost telemetry is best-effort.
  }

  state.dispatchedClaims = simpleOutcome.claims;
  if (persistState) goalState.writeStateAtomic(dir, state);

  // 4. Compose final trace.
  const simpleTrace = synthesize({ ...normalized, lanes: simpleLanes }, simpleOutcome.claims, simpleOutcome.pollOutcome);
  const simpleByName = new Map(simpleTrace.lanes.map((l) => [l.name, l]));
  const patternByName = new Map(patternLaneOutcomes.map((o) => [o.lane.name, summarizePatternLane(o.lane, o.patternResult)]));
  const allLanes = normalized.lanes.map((lane) => simpleByName.get(lane.name) || patternByName.get(lane.name));
  const overallOk = !simpleOutcome.aborted && !simpleOutcome.cancelled && allLanes.every((l) => l && l.status === 'done');
  const greenLanes = allLanes.filter((l) => l && l.status === 'done').map((l) => l.name);
  const redLanes = allLanes.filter((l) => !l || l.status !== 'done').map((l) => l ? `${l.name}:${l.status}` : 'lane:missing');
  const trace = {
    schema: TRACE_SCHEMA,
    goalId: normalized.id,
    title: normalized.title,
    ok: overallOk,
    generatedAt: new Date().toISOString(),
    lanes: allLanes,
    green: greenLanes,
    red: redLanes,
    definitionOfDone: normalized.definitionOfDone,
    mockAgents,
    dispatchClaims: simpleOutcome.claims,
    synthesizedMockResults: simpleOutcome.synthesized,
    patternLanes: patternLaneOutcomes.map((o) => ({
      name: o.lane.name,
      pattern: o.lane.pattern,
      ok: o.patternResult.ok,
      patternTrace: o.patternResult,
    })),
    taskflowSnapshot: simpleLanes.length > 0
      ? buildTaskflowMirror({ ...normalized, lanes: simpleLanes }, simpleOutcome.claims, simpleOutcome.pollOutcome)
      : sharedTaskflow.snapshot(),
    cost: state.cost,
    aborted: Boolean(simpleOutcome.aborted),
    cancelled: Boolean(simpleOutcome.cancelled),
    subGoalResults: state.subGoalResults || [],
  };

  state.synthesis = {
    ok: overallOk,
    green: greenLanes,
    red: redLanes,
    aborted: Boolean(simpleOutcome.aborted),
    cancelled: Boolean(simpleOutcome.cancelled),
    generatedAt: trace.generatedAt,
  };
  state.status = simpleOutcome.cancelled
    ? 'cancelled'
    : (overallOk ? 'done' : (simpleOutcome.aborted ? 'aborted' : 'failed'));
  state.completedAt = new Date().toISOString();
  state.goalEnd = Date.now();

  // Hermes-port goal:end hook. Fired as a notification; we do not honour
  // `block` here because the goal has already finished. We still surface
  // any context the hook contributed (e.g. a release-notes summary).
  const goalEndHook = await runEventHook('goal:end', {
    goalId: state.goalId,
    ok: overallOk,
    status: state.status,
    ms: Date.parse(state.completedAt) - Date.parse(state.createdAt || state.completedAt),
  }, { onProgress });
  if (goalEndHook.context && goalEndHook.context.length) {
    state.hookContext = state.hookContext || {};
    state.hookContext['goal:end'] = goalEndHook.context;
  }
  if (persistState) {
    goalState.writeStateAtomic(dir, state);
    trace.statePath = goalState.statePath(dir, state.goalId);
  }
  emitProgress(onProgress, { kind: 'goal-done', goalId: state.goalId, ok: overallOk, status: state.status, usd: state.cost.usd, callCount: state.cost.callCount });
  return trace;
}

/**
 * Dispatch and collect every simple lane, honouring per-lane `failure_mode`.
 *
 * Strategy:
 *   1. Dispatch all lanes (or only those not yet dispatched, for resume).
 *   2. In mock mode, synthesize one result per claim immediately.
 *   3. Poll for results.
 *   4. For any failed lane with `failure_mode: retry-N`, re-dispatch under a
 *      new taskId suffix (so the previous result is preserved on the ledger)
 *      and poll again. Repeat up to N times per lane.
 *   5. If any lane stays failed and its mode is `abort`, return with
 *      `aborted: true`.
 *
 * Returns `{ claims, pollOutcome, synthesized, aborted }`.
 */
/**
 * Look at the ledger for a `cancel-request` decision targeting this goal. If
 * one is present, mark the state cancelled and return the cancel marker.
 * Returns null when no cancel is pending.
 */
function checkCancelRequest(ledger, state, normalized) {
  let records;
  try { records = ledger.readRecords(); } catch (_) { return null; }
  const marker = goalState.findCancelRequest(records, normalized.id);
  if (!marker) return null;
  state.cancelRequest = marker;
  state.status = 'cancelled';
  return marker;
}

async function runSimpleLanes({
  ledger, normalized, simpleLanes, mockAgents, maxWaitMs, pollIntervalMs, now,
  onProgress, state, persistState, goalsDir, isResume,
}) {
  const laneStartTimes = new Map();
  const goalStartTs = state.goalStart != null ? state.goalStart : Date.now();
  state.goalStart = goalStartTs;

  // Pre-dispatch cancel check.
  const preCancel = checkCancelRequest(ledger, state, normalized);
  if (preCancel) {
    if (persistState) goalState.writeStateAtomic(goalsDir, state);
    emitProgress(onProgress, { kind: 'goal-cancelled', goalId: normalized.id, reason: preCancel.rationale });
    return { claims: [], pollOutcome: { done: [], pending: [], results: [] }, synthesized: [], aborted: false, cancelled: true };
  }

  // Hermes-port lane:dispatch hooks. Fire one event per lane before any
  // claim is written to the ledger. A hook that returns `block` removes
  // the lane from the dispatch set and adds a `decision: blocked` record
  // to the blackboard so the trace surfaces the gate.
  const dispatchableLanes = [];
  const blockedLaneOutcomes = [];
  for (const lane of simpleLanes) {
    const hookResult = await runEventHook('lane:dispatch', {
      goalId: normalized.id,
      laneId: lane.name,
      role: lane.role,
      subject: `${normalized.id}.${lane.name}`,
      summary: lane.summary,
    }, { onProgress });
    if (hookResult.decision === 'block') {
      try {
        ledger.recordDecision({
          agent: ORCHESTRATOR_AGENT,
          decision: `lane-blocked:${lane.name}`,
          status: 'blocked',
          rationale: `lane:dispatch hook ${hookResult.blockerHookId} returned block: ${hookResult.reason}`,
        });
      } catch (_) { /* ledger may not support recordDecision in some test harnesses */ }
      blockedLaneOutcomes.push({
        laneName: lane.name,
        role: lane.role,
        taskId: `${normalized.id}.${lane.name}`,
        ok: false,
        summary: `lane:dispatch hook ${hookResult.blockerHookId} blocked: ${hookResult.reason}`,
        artifacts: [],
        ts: new Date().toISOString(),
        agent: 'hook-dispatcher',
        hookBlocked: true,
      });
      emitProgress(onProgress, { kind: 'lane-hook-blocked', laneName: lane.name, hookId: hookResult.blockerHookId, reason: hookResult.reason });
      continue;
    }
    dispatchableLanes.push(lane);
  }

  const existingClaimed = isResume ? existingClaimedLaneNames(ledger, { id: normalized.id, lanes: dispatchableLanes }) : null;
  let claims;
  try {
    claims = dispatchLanes(ledger, { ...normalized, lanes: dispatchableLanes }, { skipExisting: existingClaimed });
  } catch (err) {
    if (err instanceof BlackboardValidationError || err instanceof TaskFlowError) {
      throw new GoalValidationError(`dispatch failed: ${err.message}`, err.details || {});
    }
    throw err;
  }
  for (const c of claims) {
    laneStartTimes.set(c.laneName, Date.now());
    emitProgress(onProgress, { kind: 'lane-dispatched', laneName: c.laneName, role: c.role, taskId: c.taskId, resumed: Boolean(c.resumed) });
  }

  let synthesized = [];
  if (mockAgents) {
    synthesized = synthesizeMockResults(ledger, { ...normalized, lanes: dispatchableLanes }, claims);
  }

  let pollOutcome = await pollForResults(ledger, claims, {
    maxWaitMs: mockAgents ? 5000 : maxWaitMs,
    pollIntervalMs,
    now,
    onProgress,
  });

  // Record per-lane timings for everything we have results for.
  for (const done of pollOutcome.done) {
    const start = laneStartTimes.get(done.laneName);
    if (start == null) continue;
    goalState.recordLaneTiming(state, {
      laneName: done.laneName,
      role: laneRoleFor(simpleLanes, done.laneName),
      startMs: Math.max(0, start - goalStartTs),
      endMs: Math.max(0, Date.now() - goalStartTs),
      status: done.ok ? 'done' : 'failed',
      attempt: 0,
    });
  }

  // Post-poll cancel check — operator may have written cancel-request while
  // we were polling, in which case we should stop processing further lanes.
  const midCancel = checkCancelRequest(ledger, state, normalized);
  if (midCancel) {
    if (persistState) goalState.writeStateAtomic(goalsDir, state);
    emitProgress(onProgress, { kind: 'goal-cancelled', goalId: normalized.id, reason: midCancel.rationale });
    return { claims, pollOutcome, synthesized, aborted: false, cancelled: true };
  }

  // Fire lane:result for every result we collected.
  for (const done of pollOutcome.done) {
    await runEventHook('lane:result', {
      goalId: normalized.id,
      laneId: done.laneName,
      role: laneRoleFor(simpleLanes, done.laneName),
      status: done.ok ? 'ok' : 'failed',
      ms: Date.parse(done.ts) - Date.parse(state.createdAt || done.ts),
    }, { onProgress });
  }

  // Re-fold blocked lanes into the pollOutcome shape so the synthesis loop
  // treats them uniformly as failed lanes — they cannot be retried (the
  // hook is the authority) and they count as red.
  if (blockedLaneOutcomes.length > 0) {
    pollOutcome = {
      done: pollOutcome.done.concat(blockedLaneOutcomes),
      pending: pollOutcome.pending,
      results: pollOutcome.results,
    };
  }

  state.dispatchedClaims = claims;
  state.receivedResults = pollOutcome.results.slice();
  if (persistState) goalState.writeStateAtomic(goalsDir, state);

  const laneByName = new Map(simpleLanes.map((l) => [l.name, l]));
  const retryCounts = new Map();
  const fallbackUsed = new Set();
  let aborted = false;
  let cancelled = false;

  // Record an initial recovery entry for any failed lane based on its policy
  // (continue/abort/retry/fallback). This makes the recovery audit trail
  // independent of whether retries succeed.
  for (const done of pollOutcome.done) {
    if (done.ok) continue;
    const lane = laneByName.get(done.laneName);
    if (!lane) continue;
    const mode = lane.failureMode || { kind: 'abort' };
    goalState.recordLaneRecovery(state, {
      laneName: done.laneName,
      role: lane.role,
      attempt: 0,
      action: mode.kind,
      reason: done.summary || 'lane failed',
      fallbackRole: mode.fallbackRole || null,
      finalStatus: mode.kind === 'continue' ? 'failed-but-continued' : 'pending-recovery',
      degraded: mode.kind === 'continue',
    });
  }
  if (persistState) goalState.writeStateAtomic(goalsDir, state);

  while (true) {
    // Cancel check at the head of every retry iteration.
    const cancel = checkCancelRequest(ledger, state, normalized);
    if (cancel) {
      cancelled = true;
      emitProgress(onProgress, { kind: 'goal-cancelled', goalId: normalized.id, reason: cancel.rationale });
      break;
    }

    const failedLanes = pollOutcome.done.filter((d) => !d.ok);
    const retriable = failedLanes.filter((d) => {
      const lane = laneByName.get(d.laneName);
      if (!lane) return false;
      const mode = lane.failureMode || { kind: 'abort' };
      if (mode.kind !== 'retry') return false;
      const used = retryCounts.get(d.laneName) || 0;
      return used < mode.retries;
    });

    const fallbackable = failedLanes.filter((d) => {
      const lane = laneByName.get(d.laneName);
      if (!lane) return false;
      const mode = lane.failureMode || { kind: 'abort' };
      return mode.kind === 'fallback' && !fallbackUsed.has(d.laneName);
    });

    const aborters = failedLanes.filter((d) => {
      const lane = laneByName.get(d.laneName);
      const mode = (lane && lane.failureMode) || { kind: 'abort' };
      return mode.kind === 'abort';
    });
    if (aborters.length > 0) {
      aborted = true;
      for (const a of aborters) {
        const lane = laneByName.get(a.laneName);
        goalState.recordLaneRecovery(state, {
          laneName: a.laneName,
          role: lane ? lane.role : 'unknown',
          attempt: retryCounts.get(a.laneName) || 0,
          action: 'abort',
          reason: a.summary || 'aborting due to lane failure',
          finalStatus: 'aborted',
          degraded: false,
        });
      }
      if (persistState) goalState.writeStateAtomic(goalsDir, state);
      emitProgress(onProgress, { kind: 'lane-aborted', laneNames: aborters.map((a) => a.laneName) });
      break;
    }

    // Handle fallback path: dispatch a single retry under the fallback role.
    if (fallbackable.length > 0) {
      const fallbackClaims = [];
      for (const failed of fallbackable) {
        const lane = laneByName.get(failed.laneName);
        fallbackUsed.add(failed.laneName);
        const fallbackRole = lane.failureMode.fallbackRole;
        const fbTaskId = `${normalized.id}.${lane.name}.fallback-${fallbackRole}`;
        const summary = `[${normalized.id}][fallback->${fallbackRole}] ${lane.summary}`.slice(0, 500);
        const claim = ledger.claimTask({ agent: ORCHESTRATOR_AGENT, taskId: fbTaskId, summary, forRole: fallbackRole });
        fallbackClaims.push({ laneName: lane.name, role: fallbackRole, taskId: fbTaskId, claimId: claim.id, claimedAt: claim.ts, fallback: true });
        laneStartTimes.set(`${lane.name}::fallback`, Date.now());
        emitProgress(onProgress, { kind: 'lane-fallback-dispatch', laneName: lane.name, fallbackRole, taskId: fbTaskId });
      }
      if (mockAgents) {
        const fbLanes = fallbackClaims.map((c) => ({ ...laneByName.get(c.laneName), role: c.role }));
        const fbSynth = synthesizeMockResults(ledger, { ...normalized, lanes: fbLanes }, fallbackClaims, { strategy: 'all-ok' });
        synthesized = synthesized.concat(fbSynth);
      }
      const fbOutcome = await pollForResults(ledger, fallbackClaims, {
        maxWaitMs: mockAgents ? 5000 : maxWaitMs,
        pollIntervalMs,
        now,
        onProgress,
      });
      const fbDoneByLane = new Map(fbOutcome.done.map((d) => [d.laneName, d]));
      const okLanes = pollOutcome.done.filter((d) => d.ok);
      const stillFailedAfterFallback = new Set();
      const replaced = [];
      for (const failed of failedLanes) {
        const fbDone = fbDoneByLane.get(failed.laneName);
        if (fbDone) {
          replaced.push({ ...fbDone, originalTaskId: failed.taskId, fallback: true });
          if (!fbDone.ok) stillFailedAfterFallback.add(failed.laneName);
          // Record the final fallback outcome on the recovery trail.
          const lane = laneByName.get(failed.laneName);
          goalState.recordLaneRecovery(state, {
            laneName: failed.laneName,
            role: lane ? lane.role : 'unknown',
            attempt: 1,
            action: 'fallback',
            reason: fbDone.summary || 'fallback dispatch completed',
            fallbackRole: lane && lane.failureMode && lane.failureMode.fallbackRole || null,
            finalStatus: fbDone.ok ? 'recovered' : 'failed-after-fallback',
            degraded: !fbDone.ok,
          });
          // Record timing for the fallback attempt.
          const fbStart = laneStartTimes.get(`${failed.laneName}::fallback`);
          if (fbStart != null) {
            goalState.recordLaneTiming(state, {
              laneName: failed.laneName,
              role: lane ? lane.failureMode.fallbackRole : 'unknown',
              startMs: Math.max(0, fbStart - goalStartTs),
              endMs: Math.max(0, Date.now() - goalStartTs),
              status: fbDone.ok ? 'done' : 'failed',
              attempt: 1,
            });
          }
        } else {
          replaced.push(failed);
          stillFailedAfterFallback.add(failed.laneName);
        }
      }
      pollOutcome = {
        done: okLanes.concat(replaced),
        pending: fbOutcome.pending,
        results: pollOutcome.results.concat(fbOutcome.results),
      };
      state.receivedResults = pollOutcome.results.slice();
      state.dispatchedClaims = claims.concat(fallbackClaims);
      if (persistState) goalState.writeStateAtomic(goalsDir, state);
      if (stillFailedAfterFallback.size === 0 && retriable.length === 0) break;
      // After fallback we still allow retry to take a swing if any lane has
      // both modes (rare); loop continues.
    }

    if (retriable.length === 0 && fallbackable.length === 0) {
      // No lane wants further action — mark continue lanes terminal.
      for (const f of failedLanes) {
        const lane = laneByName.get(f.laneName);
        if (lane && lane.failureMode && lane.failureMode.kind === 'continue') {
          // Already recorded above; nothing more to do.
        }
      }
      break;
    }

    if (retriable.length === 0) continue;

    const retryClaims = [];
    const retryStartByLane = new Map();
    for (const failed of retriable) {
      const lane = laneByName.get(failed.laneName);
      const used = retryCounts.get(failed.laneName) || 0;
      retryCounts.set(failed.laneName, used + 1);
      const retryTaskId = `${normalized.id}.${lane.name}.retry-${used + 1}`;
      const summary = `[${normalized.id}][retry ${used + 1}/${lane.failureMode.retries}] ${lane.summary}`.slice(0, 500);
      const backoffMs = Math.min(2000, 100 * Math.pow(2, used));
      await sleepAsync(backoffMs);
      const claim = ledger.claimTask({ agent: ORCHESTRATOR_AGENT, taskId: retryTaskId, summary, forRole: lane.role });
      retryClaims.push({ laneName: lane.name, role: lane.role, taskId: retryTaskId, claimId: claim.id, claimedAt: claim.ts, retry: used + 1 });
      retryStartByLane.set(lane.name, Date.now());
      emitProgress(onProgress, { kind: 'lane-retry-dispatch', laneName: lane.name, attempt: used + 1, max: lane.failureMode.retries, taskId: retryTaskId });
    }

    let retrySynthesized = [];
    if (mockAgents) {
      retrySynthesized = synthesizeMockResults(ledger, {
        ...normalized,
        lanes: simpleLanes.filter((l) => retryClaims.some((r) => r.laneName === l.name)),
      }, retryClaims, { strategy: 'all-ok' });
    }
    synthesized = synthesized.concat(retrySynthesized);

    const retryOutcome = await pollForResults(ledger, retryClaims, {
      maxWaitMs: mockAgents ? 5000 : maxWaitMs,
      pollIntervalMs,
      now,
      onProgress,
    });

    const okLanes = pollOutcome.done.filter((d) => d.ok);
    const retryDoneByLane = new Map(retryOutcome.done.map((d) => [d.laneName, d]));
    const stillFailedLaneNames = new Set();
    const replaced = [];
    for (const failed of failedLanes) {
      const retryDone = retryDoneByLane.get(failed.laneName);
      if (retryDone) {
        replaced.push({ ...retryDone, originalTaskId: failed.taskId });
        if (!retryDone.ok) stillFailedLaneNames.add(failed.laneName);
        const lane = laneByName.get(failed.laneName);
        const attemptCount = retryCounts.get(failed.laneName) || 0;
        goalState.recordLaneRecovery(state, {
          laneName: failed.laneName,
          role: lane ? lane.role : 'unknown',
          attempt: attemptCount,
          action: 'retry',
          reason: retryDone.summary || 'retry attempt completed',
          finalStatus: retryDone.ok ? 'recovered' : 'failed-retry',
          degraded: !retryDone.ok,
        });
        const rStart = retryStartByLane.get(failed.laneName);
        if (rStart != null) {
          goalState.recordLaneTiming(state, {
            laneName: failed.laneName,
            role: lane ? lane.role : 'unknown',
            startMs: Math.max(0, rStart - goalStartTs),
            endMs: Math.max(0, Date.now() - goalStartTs),
            status: retryDone.ok ? 'done' : 'failed',
            attempt: attemptCount,
          });
        }
      } else {
        replaced.push(failed);
        stillFailedLaneNames.add(failed.laneName);
      }
    }
    pollOutcome = {
      done: okLanes.concat(replaced),
      pending: retryOutcome.pending,
      results: pollOutcome.results.concat(retryOutcome.results),
    };
    state.receivedResults = pollOutcome.results.slice();
    state.dispatchedClaims = claims.concat(retryClaims);
    if (persistState) goalState.writeStateAtomic(goalsDir, state);

    if (stillFailedLaneNames.size === 0) break;
  }

  return { claims, pollOutcome, synthesized, aborted, cancelled };
}

/**
 * Run a sub-goal inline as part of a parent goal-loop. The sub-goal is a
 * normalized goal; we execute it with the same blackboard ledger as the
 * parent, persist its state under `<parentDir>/sub/<parent>/<sub>.json`, and
 * return its trace. Sub-goals always run with no recursion of their own sub-
 * goals — to avoid surprise unbounded trees, we strip `subGoals` before
 * dispatch.
 *
 * In mock mode the sub-goal also runs in mock mode. Cancel observation in the
 * parent does NOT propagate down: each sub-goal observes its own
 * `cancel-request` (keyed on the sub-goal id) independently.
 */
async function runSubGoalInline({ subGoal, parentGoalId, parentDir, ledger, blackboardPath, mockAgents, onProgress }) {
  const subState = goalState.newState({
    goal: { ...subGoal, subGoals: [] },
    blackboardPath,
    options: { mockAgents, dryRun: false, maxWaitMs: mockAgents ? 5000 : 30000, pollIntervalMs: 100, parentGoalId },
  });
  subState.parentGoalId = parentGoalId;
  // Persist the sub-goal state file before dispatch so a partial run is
  // still discoverable via `listSubGoalStates`.
  if (parentDir) goalState.writeSubGoalStateAtomic(parentDir, parentGoalId, subState);

  // Dispatch + synthesize + collect, using only simple lanes (sub-goal
  // pattern lanes are out of scope for this minimal recursion).
  const subSimpleLanes = subGoal.lanes.filter((l) => !l.pattern);
  const simpleOutcome = await runSimpleLanes({
    ledger,
    normalized: { ...subGoal, subGoals: [] },
    simpleLanes: subSimpleLanes,
    mockAgents,
    maxWaitMs: mockAgents ? 5000 : 30000,
    pollIntervalMs: 100,
    now: Date.now,
    onProgress,
    state: subState,
    persistState: Boolean(parentDir),
    goalsDir: parentDir,
    isResume: false,
  });

  const subTrace = synthesize({ ...subGoal, lanes: subSimpleLanes }, simpleOutcome.claims, simpleOutcome.pollOutcome);
  subTrace.cost = subState.cost;
  subTrace.statePath = parentDir ? goalState.subGoalStatePath(parentDir, parentGoalId, subGoal.id) : null;
  subTrace.parentGoalId = parentGoalId;
  subTrace.ok = !simpleOutcome.aborted && !simpleOutcome.cancelled && subTrace.lanes.every((l) => l.status === 'done');
  subState.synthesis = {
    ok: subTrace.ok,
    green: subTrace.green,
    red: subTrace.red,
    aborted: Boolean(simpleOutcome.aborted),
    cancelled: Boolean(simpleOutcome.cancelled),
    generatedAt: subTrace.generatedAt,
  };
  subState.status = simpleOutcome.cancelled ? 'cancelled' : (subTrace.ok ? 'done' : 'failed');
  subState.completedAt = new Date().toISOString();
  subState.goalEnd = Date.now();
  subState.dispatchedClaims = simpleOutcome.claims;
  subState.receivedResults = simpleOutcome.pollOutcome.results.slice();
  if (parentDir) goalState.writeSubGoalStateAtomic(parentDir, parentGoalId, subState);
  return subTrace;
}

/**
 * For a fully-completed goal in the state file, rebuild a trace that matches
 * what the original run would have produced. Used when --resume is invoked
 * on an already-done goal: the call is a no-op but we still return a trace
 * so the CLI surface is stable.
 */
function rebuildTraceFromState(state) {
  return {
    schema: TRACE_SCHEMA,
    goalId: state.goalId,
    title: state.title,
    ok: state.status === 'done',
    resumedNoop: true,
    generatedAt: new Date().toISOString(),
    lanes: goalState.laneStatusFromResults(state.goal, state.dispatchedClaims || [], state.patternLanes || [], state.receivedResults || []),
    green: (state.synthesis && state.synthesis.green) || [],
    red: (state.synthesis && state.synthesis.red) || [],
    definitionOfDone: state.goal.definitionOfDone,
    mockAgents: state.options && state.options.mockAgents,
    cost: state.cost,
    aborted: Boolean(state.synthesis && state.synthesis.aborted),
    statePath: null,
  };
}

/**
 * Read the blackboard and return an operator-friendly status digest. Used by
 * `openclaw status`.
 */
function blackboardSummary(blackboardPath, { recentLimit = 10 } = {}) {
  if (!fs.existsSync(blackboardPath)) {
    return {
      schema: 'openclaw-frontier.blackboard-summary.v1',
      ledgerPath: blackboardPath,
      exists: false,
      totalRecords: 0,
      tasks: { active: [], done: [], failed: [] },
      pathClaims: [],
      recentResults: [],
      counts: {},
    };
  }
  const ledger = createLedger({ ledgerPath: blackboardPath });
  const snapshot = ledger.snapshot();
  const tasksArr = Object.entries(snapshot.tasks).map(([taskId, task]) => ({ taskId, ...task }));
  const active = tasksArr.filter((t) => t.status === 'claimed');
  const done = tasksArr.filter((t) => t.status === 'done');
  const failed = tasksArr.filter((t) => t.status === 'failed');
  const pathClaims = Object.entries(snapshot.pathClaims).map(([p, claim]) => ({ path: p, ...claim }));
  const recentResults = snapshot.results.slice(-recentLimit).reverse();
  return {
    schema: 'openclaw-frontier.blackboard-summary.v1',
    ledgerPath: blackboardPath,
    exists: true,
    totalRecords: Object.values(snapshot.counts || {}).reduce((a, b) => a + b, 0),
    tasks: { active, done, failed },
    pathClaims,
    recentResults,
    counts: snapshot.counts || {},
  };
}

/**
 * Recap: read the blackboard and roll activity from the past N days into a
 * one-page executive summary suitable for chat or status posts. Used by
 * `openclaw recap`.
 */
function recapBlackboard(blackboardPath, { days = 1, now = () => new Date(), includeCost = false, goalsDir = null } = {}) {
  if (!fs.existsSync(blackboardPath)) {
    return {
      schema: 'openclaw-frontier.blackboard-recap.v1',
      ledgerPath: blackboardPath,
      exists: false,
      sinceISO: new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
      totals: { tasks: 0, results: 0, facts: 0, decisions: 0 },
      perRole: {},
      narrative: ['No blackboard ledger found.'],
    };
  }
  const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
  const ledger = createLedger({ ledgerPath: blackboardPath });
  const records = ledger.readRecords().filter((r) => new Date(r.ts).getTime() >= cutoff);
  const totals = { tasks: 0, results: 0, facts: 0, decisions: 0, paths: 0 };
  const perRole = {};
  for (const record of records) {
    if (record.kind === 'task-claim') totals.tasks += 1;
    else if (record.kind === 'result') totals.results += 1;
    else if (record.kind === 'fact') totals.facts += 1;
    else if (record.kind === 'decision') totals.decisions += 1;
    else if (record.kind === 'path-claim') totals.paths += 1;
    const agent = record.agent || 'unknown';
    perRole[agent] = perRole[agent] || { claims: 0, results: 0, oks: 0, fails: 0 };
    if (record.kind === 'task-claim') perRole[agent].claims += 1;
    if (record.kind === 'result') {
      perRole[agent].results += 1;
      if (record.ok) perRole[agent].oks += 1;
      else perRole[agent].fails += 1;
    }
  }
  const narrative = [];
  narrative.push(`Window: last ${days} day${days === 1 ? '' : 's'} (since ${new Date(cutoff).toISOString()})`);
  narrative.push(`Tasks claimed: ${totals.tasks}, results recorded: ${totals.results}, decisions: ${totals.decisions}, facts: ${totals.facts}, path claims: ${totals.paths}`);
  const okResults = records.filter((r) => r.kind === 'result' && r.ok).length;
  const failResults = records.filter((r) => r.kind === 'result' && !r.ok).length;
  if (totals.results > 0) {
    narrative.push(`Of ${totals.results} results, ${okResults} ok and ${failResults} failed.`);
  } else {
    narrative.push('No results were recorded in the window.');
  }
  for (const [agent, stats] of Object.entries(perRole)) {
    if (stats.claims === 0 && stats.results === 0) continue;
    narrative.push(`  ${agent}: ${stats.claims} claims, ${stats.results} results (${stats.oks} ok / ${stats.fails} fail)`);
  }
  let goalCosts = null;
  if (includeCost) {
    goalCosts = recapGoalCosts(blackboardPath, { records, cutoffMs: cutoff, goalsDir });
    if (goalCosts.goals.length === 0) {
      narrative.push('No per-goal cost records in the window.');
    } else {
      narrative.push(`Total estimated cost across ${goalCosts.goals.length} goals: $${goalCosts.totalUsd.toFixed(6)} (${goalCosts.totalCallCount} model calls).`);
      for (const g of goalCosts.goals.slice(0, 10)) {
        narrative.push(`  ${g.goalId} (${g.status}): $${g.usd.toFixed(6)} over ${g.callCount} call${g.callCount === 1 ? '' : 's'}`);
      }
    }
  }
  return {
    schema: 'openclaw-frontier.blackboard-recap.v1',
    ledgerPath: blackboardPath,
    exists: true,
    sinceISO: new Date(cutoff).toISOString(),
    untilISO: now().toISOString(),
    totals,
    perRole,
    cost: goalCosts,
    narrative,
  };
}

function recapGoalCosts(blackboardPath, { records, cutoffMs, goalsDir }) {
  const dir = goalsDir || goalState.resolveGoalsDir({ blackboardPath });
  const goals = [];
  if (fs.existsSync(dir)) {
    for (const entry of goalState.listStates(dir, { all: true })) {
      if (entry.mtime < cutoffMs) continue;
      goals.push({ goalId: entry.goalId, title: entry.title, status: entry.status, usd: entry.usd, callCount: entry.callCount, updatedAt: entry.updatedAt });
    }
  }
  const usageFacts = extractUsageFacts(records || []);
  const facts = usageFacts.map((f) => {
    const est = estimateCallCost({ model: f.model, usage: f.usage });
    return { ts: f.ts, taskId: f.taskId, agent: f.agent, model: f.model, usd: est.usd };
  });
  const totalUsd = goals.reduce((a, g) => a + (g.usd || 0), 0);
  const totalCallCount = goals.reduce((a, g) => a + (g.callCount || 0), 0);
  return { goals, totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000, totalCallCount, factEstimates: facts };
}

module.exports = {
  GOAL_SCHEMA,
  TRACE_SCHEMA,
  ORCHESTRATOR_AGENT,
  USAGE_FACT_SUBJECT_PREFIX,
  GoalValidationError,
  normalizeGoal,
  normalizeFailureMode,
  normalizeSubGoalSpec,
  goalFromPrompt,
  defaultLanePlan,
  dispatchLanes,
  pollForResults,
  synthesizeMockResults,
  synthesize,
  buildTaskflowMirror,
  runGoalLoop,
  runSubGoalInline,
  checkCancelRequest,
  blackboardSummary,
  recapBlackboard,
  toSimpleAgentId,
  toSimpleTaskId,
  sha256OfJson,
  extractUsageFacts,
  applyUsageFactsToState,
  goalState,
};
