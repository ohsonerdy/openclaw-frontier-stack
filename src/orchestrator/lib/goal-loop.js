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
    const name = toSimpleTaskId(lane.name || `lane-${index + 1}`, `goal.lanes[${index}].name`);
    if (seen.has(name)) {
      throw new GoalValidationError(`goal.lanes[${index}].name is a duplicate: ${name}`);
    }
    seen.add(name);
    const role = toSimpleAgentId(lane.role || lane.owner || 'builder', `goal.lanes[${index}].role`);
    const summary = String(lane.summary || lane.description || `Lane ${name}`).trim().slice(0, 500);
    const expects = Array.isArray(lane.expects) ? lane.expects.map(String).slice(0, 16) : [];
    return { name, role, summary, expects };
  });

  const cadence = input.cadence && typeof input.cadence === 'object'
    ? {
        operatorUpdateMinutes: Number(input.cadence.operatorUpdateMinutes) || 30,
        channel: String(input.cadence.channel || 'operator-chat').slice(0, 64),
      }
    : { operatorUpdateMinutes: 30, channel: 'operator-chat' };

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
    green: Array.isArray(input.green) ? input.green.map((s) => String(s).slice(0, 500)) : [],
    red: Array.isArray(input.red) ? input.red.map((s) => String(s).slice(0, 500)) : [],
  };
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
function goalFromPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw new GoalValidationError('goal prompt must be a non-empty string');
  const slug = toSimpleTaskId(text.slice(0, 60), 'goal.id');
  const id = `goal-${slug}-${shortId()}`;
  return normalizeGoal({
    id,
    title: text.slice(0, 200),
    source: 'cli-prompt',
    lanes: defaultLanePlan(),
  });
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
function dispatchLanes(ledger, goal) {
  const claims = [];
  for (const lane of goal.lanes) {
    const taskId = `${goal.id}.${lane.name}`;
    const summary = `[${goal.id}] ${lane.summary}`.slice(0, 500);
    const claim = ledger.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary,
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

/**
 * Block synchronously waiting for result records for every dispatched task.
 *
 * The implementation re-reads the ledger snapshot every `pollIntervalMs` ms
 * until either all tasks have a matching result or `maxWaitMs` elapses.
 *
 * Returns `{ done, pending, results }` where:
 *   - `done` is the list of `{ taskId, ok, summary, artifacts, ts, agent }`
 *     for tasks that completed
 *   - `pending` is the list of taskIds still waiting
 *   - `results` is the raw result records from the ledger snapshot
 */
function pollForResults(ledger, claims, { maxWaitMs = 300000, pollIntervalMs = 250, now = Date.now } = {}) {
  const wantedIds = new Set(claims.map((claim) => claim.taskId));
  const started = now();
  while (true) {
    const snapshot = ledger.snapshot();
    const done = [];
    const pending = [];
    for (const claim of claims) {
      const result = snapshot.results.find((r) => r.taskId === claim.taskId);
      if (result) {
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
    sleepSync(pollIntervalMs);
  }
}

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
 * The orchestration harness entrypoint. Inputs:
 *
 *   - goal: a normalized goal record (or raw input — we'll normalize)
 *   - blackboardPath: absolute path to a blackboard ledger jsonl file
 *   - maxWaitMs: budget for waiting on live agents (default 5min)
 *   - mockAgents: when true, synthesize results immediately after dispatch
 *   - dryRun: when true, do not write to the ledger at all; return a
 *     simulated trace describing what would have happened
 */
function runGoalLoop({
  goal,
  blackboardPath,
  maxWaitMs = 300000,
  mockAgents = false,
  dryRun = false,
  pollIntervalMs = 200,
  now = Date.now,
} = {}) {
  const normalized = normalizeGoal(goal);

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
        taskId: `${normalized.id}.${lane.name}`,
        status: 'would-dispatch',
        ok: false,
        summary: 'dry-run: no claim written, no result solicited',
        artifacts: [],
      })),
      green: [],
      red: normalized.lanes.map((l) => `${l.name}:would-dispatch`),
      definitionOfDone: normalized.definitionOfDone,
      mockAgents,
    };
  }

  const ledger = createLedger({ ledgerPath: blackboardPath });
  let claims;
  try {
    claims = dispatchLanes(ledger, normalized);
  } catch (err) {
    if (err instanceof BlackboardValidationError || err instanceof TaskFlowError) {
      throw new GoalValidationError(`dispatch failed: ${err.message}`, err.details || {});
    }
    throw err;
  }

  let synthesized = [];
  if (mockAgents) {
    synthesized = synthesizeMockResults(ledger, normalized, claims);
  }
  const pollOutcome = pollForResults(ledger, claims, {
    maxWaitMs: mockAgents ? 5000 : maxWaitMs,
    pollIntervalMs,
    now,
  });
  const trace = synthesize(normalized, claims, pollOutcome);
  trace.mockAgents = mockAgents;
  trace.dispatchClaims = claims;
  trace.synthesizedMockResults = synthesized;
  trace.taskflowSnapshot = buildTaskflowMirror(normalized, claims, pollOutcome);
  return trace;
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
function recapBlackboard(blackboardPath, { days = 1, now = () => new Date() } = {}) {
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
  return {
    schema: 'openclaw-frontier.blackboard-recap.v1',
    ledgerPath: blackboardPath,
    exists: true,
    sinceISO: new Date(cutoff).toISOString(),
    untilISO: now().toISOString(),
    totals,
    perRole,
    narrative,
  };
}

module.exports = {
  GOAL_SCHEMA,
  TRACE_SCHEMA,
  ORCHESTRATOR_AGENT,
  GoalValidationError,
  normalizeGoal,
  goalFromPrompt,
  defaultLanePlan,
  dispatchLanes,
  pollForResults,
  synthesizeMockResults,
  synthesize,
  buildTaskflowMirror,
  runGoalLoop,
  blackboardSummary,
  recapBlackboard,
  toSimpleAgentId,
  toSimpleTaskId,
  sha256OfJson,
};
