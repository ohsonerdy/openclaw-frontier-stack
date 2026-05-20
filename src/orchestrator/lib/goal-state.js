'use strict';

/**
 * goal-state.js — cross-session goal-state persistence.
 *
 * Every `openclaw goal` invocation writes a single JSON file at
 * `.openclaw/goals/<goal_id>.json` summarizing the dispatch plan, the
 * receipts collected so far, the current synthesis (if any), and the
 * estimated cost in USD.
 *
 * The file is the single resume token. `openclaw goal --resume <goal_id>`
 * reads it, re-reads the blackboard for any results that have landed
 * while the process was down, re-dispatches any lanes that have not
 * dispatched yet, then continues the polling loop and rewrites the file.
 *
 * Layout:
 *   .openclaw/goals/<goal_id>.json     # active + recently completed goals
 *   .openclaw/goals/sub/<parent>/<sub>.json   # sub-goal state files (v2+)
 *
 * The directory lives relative to the blackboard's parent so the goal-state
 * directory and the blackboard ledger live next to each other and travel
 * together (a typical operator runs everything out of one repo root).
 *
 * Schema versions:
 *   v1 (legacy, v0.7.0)  — accepted via STATE_SCHEMA_V1
 *   v2 (current, v0.8.0) — accepted via STATE_SCHEMA. Adds:
 *                           - laneRecovery: per-lane recovery records
 *                           - subGoals: configuration for nested goals
 *                           - subGoalResults: outcomes of sub-goals
 *                           - timing: start/end timestamps per lane
 *                           - cancelRequest: cancel marker when set
 *
 * v1 files are upgraded in-memory on read; the upgrader is conservative and
 * does NOT mutate the on-disk file until the next write. Tests assert v1 files
 * remain readable and produce a valid state object.
 *
 * No runtime deps. Pure Node.
 */

const fs = require('fs');
const path = require('path');

const STATE_SCHEMA = 'openclaw-frontier.goal-state.v2';
const STATE_SCHEMA_V1 = 'openclaw-frontier.goal-state.v1';
const ACCEPTED_SCHEMAS = new Set([STATE_SCHEMA, STATE_SCHEMA_V1]);

class GoalStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GoalStateError';
    this.code = 'GOAL_STATE';
    this.details = details;
  }
}

/**
 * Resolve the directory to use for goal-state files. Defaults to
 * `<blackboard-parent>/.openclaw/goals/`. If `OPENCLAW_GOALS_DIR` is set,
 * that wins.
 */
function resolveGoalsDir({ blackboardPath, override = null } = {}) {
  if (override) return path.resolve(override);
  const env = process.env.OPENCLAW_GOALS_DIR;
  if (env) return path.resolve(env);
  if (!blackboardPath) {
    return path.resolve(process.cwd(), '.openclaw', 'goals');
  }
  return path.join(path.dirname(path.resolve(blackboardPath)), '.openclaw', 'goals');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(goalsDir, goalId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(goalId))) {
    throw new GoalStateError('goal id has unsafe characters for filename', { goalId });
  }
  return path.join(goalsDir, `${goalId}.json`);
}

/**
 * Resolve a sub-goal state path: `<goalsDir>/sub/<parent>/<sub>.json`.
 */
function subGoalStatePath(goalsDir, parentId, subId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(parentId))) {
    throw new GoalStateError('parent goal id has unsafe characters for filename', { parentId });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(subId))) {
    throw new GoalStateError('sub goal id has unsafe characters for filename', { subId });
  }
  return path.join(goalsDir, 'sub', parentId, `${subId}.json`);
}

function subGoalDir(goalsDir, parentId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(parentId))) {
    throw new GoalStateError('parent goal id has unsafe characters for filename', { parentId });
  }
  return path.join(goalsDir, 'sub', parentId);
}

function newState({ goal, blackboardPath, options = {} }) {
  const subGoalsRaw = Array.isArray(goal && goal.subGoals) ? goal.subGoals : [];
  return {
    schema: STATE_SCHEMA,
    goalId: goal.id,
    title: goal.title,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    blackboardPath: path.resolve(blackboardPath || ''),
    options: {
      mockAgents: Boolean(options.mockAgents),
      dryRun: Boolean(options.dryRun),
      maxWaitMs: Number(options.maxWaitMs) || 300000,
      pollIntervalMs: Number(options.pollIntervalMs) || 200,
      templateName: options.templateName || null,
      templateContext: options.templateContext || null,
      progressFile: options.progressFile || null,
    },
    goal,
    dispatchedClaims: [],
    patternLanes: [],
    receivedResults: [],
    synthesis: null,
    errors: [],
    cost: {
      callCount: 0,
      usd: 0,
      usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
      perModel: {},
    },
    // v2 additions
    laneRecovery: [],
    laneTimings: [],
    subGoals: subGoalsRaw,
    subGoalResults: [],
    cancelRequest: null,
    parentGoalId: options.parentGoalId || null,
    goalStart: null,
    goalEnd: null,
  };
}

/**
 * Read a state file, accepting both v1 and v2 schemas. v1 records are
 * upgraded into the v2 shape in-memory (missing fields default to safe
 * empty values). The on-disk file is NOT rewritten until the next
 * `writeStateAtomic` — this keeps the call read-only when callers only
 * need to look at a goal.
 */
function readState(goalsDir, goalId) {
  const p = statePath(goalsDir, goalId);
  if (!fs.existsSync(p)) {
    throw new GoalStateError(`goal state not found: ${goalId}`, { path: p });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new GoalStateError(`goal state is not valid JSON: ${err.message}`, { path: p });
  }
  if (!parsed || typeof parsed !== 'object' || !ACCEPTED_SCHEMAS.has(parsed.schema)) {
    throw new GoalStateError('goal state file has wrong schema', { path: p, got: parsed && parsed.schema });
  }
  return upgradeStateInPlace(parsed);
}

/**
 * Read a sub-goal state file directly. Used by `openclaw goal --show` when
 * recursively dumping a parent's sub-goal results.
 */
function readSubGoalState(goalsDir, parentId, subId) {
  const p = subGoalStatePath(goalsDir, parentId, subId);
  if (!fs.existsSync(p)) {
    throw new GoalStateError(`sub-goal state not found: ${parentId}/${subId}`, { path: p });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new GoalStateError(`sub-goal state is not valid JSON: ${err.message}`, { path: p });
  }
  if (!parsed || typeof parsed !== 'object' || !ACCEPTED_SCHEMAS.has(parsed.schema)) {
    throw new GoalStateError('sub-goal state file has wrong schema', { path: p, got: parsed && parsed.schema });
  }
  return upgradeStateInPlace(parsed);
}

/**
 * In-memory v1 -> v2 upgrade. Pure function-ish (mutates the object that is
 * already in memory, which is fine — the on-disk file is untouched).
 */
function upgradeStateInPlace(state) {
  if (state.schema === STATE_SCHEMA_V1) {
    state.schema = STATE_SCHEMA;
    if (!Array.isArray(state.laneRecovery)) state.laneRecovery = [];
    if (!Array.isArray(state.laneTimings)) state.laneTimings = [];
    if (!Array.isArray(state.subGoals)) state.subGoals = [];
    if (!Array.isArray(state.subGoalResults)) state.subGoalResults = [];
    if (state.cancelRequest === undefined) state.cancelRequest = null;
    if (state.parentGoalId === undefined) state.parentGoalId = null;
    if (state.goalStart === undefined) state.goalStart = null;
    if (state.goalEnd === undefined) state.goalEnd = null;
    if (state.options && state.options.progressFile === undefined) state.options.progressFile = null;
  } else {
    // already v2 — keep defaults if missing fields slipped through
    if (!Array.isArray(state.laneRecovery)) state.laneRecovery = [];
    if (!Array.isArray(state.laneTimings)) state.laneTimings = [];
    if (!Array.isArray(state.subGoals)) state.subGoals = [];
    if (!Array.isArray(state.subGoalResults)) state.subGoalResults = [];
    if (state.cancelRequest === undefined) state.cancelRequest = null;
    if (state.parentGoalId === undefined) state.parentGoalId = null;
    if (state.goalStart === undefined) state.goalStart = null;
    if (state.goalEnd === undefined) state.goalEnd = null;
  }
  return state;
}

function writeStateAtomic(goalsDir, state) {
  ensureDir(goalsDir);
  const p = statePath(goalsDir, state.goalId);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function writeSubGoalStateAtomic(goalsDir, parentId, state) {
  const dir = subGoalDir(goalsDir, parentId);
  ensureDir(dir);
  const p = subGoalStatePath(goalsDir, parentId, state.goalId);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

function listStates(goalsDir, { limit = 20, all = false } = {}) {
  if (!fs.existsSync(goalsDir)) return [];
  const entries = fs.readdirSync(goalsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      const full = path.join(goalsDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { return null; }
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { parsed = null; }
      if (!parsed) return null;
      return {
        goalId: parsed.goalId,
        title: parsed.title,
        status: parsed.status,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        completedAt: parsed.completedAt,
        templateName: parsed.options && parsed.options.templateName,
        usd: parsed.cost ? parsed.cost.usd : 0,
        callCount: parsed.cost ? parsed.cost.callCount : 0,
        mtime: stat.mtimeMs,
        path: full,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return all ? entries : entries.slice(0, limit);
}

/**
 * List the sub-goal state files for a given parent. Returns the same shape as
 * `listStates`, but for the `<goalsDir>/sub/<parent>/` directory. Returns an
 * empty array when the directory does not exist (parent has no sub-goals).
 */
function listSubGoalStates(goalsDir, parentId, { limit = 20, all = true } = {}) {
  const dir = subGoalDir(goalsDir, parentId);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { return null; }
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { parsed = null; }
      if (!parsed) return null;
      return {
        goalId: parsed.goalId,
        title: parsed.title,
        status: parsed.status,
        parentGoalId: parsed.parentGoalId || parentId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        completedAt: parsed.completedAt,
        usd: parsed.cost ? parsed.cost.usd : 0,
        callCount: parsed.cost ? parsed.cost.callCount : 0,
        mtime: stat.mtimeMs,
        path: full,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);
  return all ? entries : entries.slice(0, limit);
}

function laneStatusFromResults(goal, dispatchedClaims, patternLanes, results) {
  // Returns an array of { name, role, pattern, taskId, status, ok, summary }.
  // status is one of: 'done', 'failed', 'pending', 'not-dispatched'.
  const byTask = new Map();
  for (const r of results) byTask.set(r.taskId, r);
  const out = [];
  for (const lane of goal.lanes) {
    if (lane.pattern) {
      const cached = patternLanes.find((p) => p.name === lane.name);
      if (!cached) {
        out.push({ name: lane.name, role: lane.role, pattern: lane.pattern, status: 'not-dispatched', ok: false, summary: 'pattern lane not yet executed' });
      } else {
        out.push({
          name: lane.name, role: lane.role, pattern: lane.pattern,
          status: cached.ok ? 'done' : 'failed',
          ok: Boolean(cached.ok),
          summary: cached.summary || `pattern lane ${lane.pattern}`,
        });
      }
      continue;
    }
    const claim = dispatchedClaims.find((c) => c.laneName === lane.name);
    if (!claim) {
      out.push({ name: lane.name, role: lane.role, pattern: null, taskId: null, status: 'not-dispatched', ok: false, summary: 'lane not yet dispatched' });
      continue;
    }
    const result = byTask.get(claim.taskId);
    if (!result) {
      out.push({ name: lane.name, role: lane.role, pattern: null, taskId: claim.taskId, status: 'pending', ok: false, summary: 'awaiting result' });
      continue;
    }
    out.push({
      name: lane.name, role: lane.role, pattern: null, taskId: claim.taskId,
      status: result.ok ? 'done' : 'failed',
      ok: Boolean(result.ok),
      summary: result.summary || '',
    });
  }
  return out;
}

function applyCallCost(state, costEstimate, { lane = null, taskId = null } = {}) {
  if (!costEstimate || typeof costEstimate.usd !== 'number') return state;
  state.cost.callCount += 1;
  state.cost.usd = Math.round((state.cost.usd + costEstimate.usd) * 1_000_000) / 1_000_000;
  for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
    state.cost.usage[k] = (state.cost.usage[k] || 0) + (costEstimate.usage[k] || 0);
  }
  const modelKey = (costEstimate.modelResolved && costEstimate.modelResolved.modelId) || costEstimate.modelId || 'unknown';
  if (!state.cost.perModel[modelKey]) {
    state.cost.perModel[modelKey] = { usd: 0, callCount: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 };
  }
  const m = state.cost.perModel[modelKey];
  m.usd = Math.round((m.usd + costEstimate.usd) * 1_000_000) / 1_000_000;
  m.callCount += 1;
  for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
    m[k] = (m[k] || 0) + (costEstimate.usage[k] || 0);
  }
  if (lane || taskId) {
    state.errors = state.errors || [];
  }
  return state;
}

function recordError(state, err) {
  state.errors.push({
    ts: new Date().toISOString(),
    message: String(err && err.message ? err.message : err),
    name: err && err.name ? err.name : 'Error',
  });
  return state;
}

/**
 * Append a `lane-recovery` entry. Recovery entries describe what failed in a
 * lane and what action the orchestrator took (continue/retry/fallback).
 *
 *   { ts, laneName, role, attempt, action, reason, fallbackRole?,
 *     finalStatus, degraded }
 */
function recordLaneRecovery(state, entry) {
  if (!state) return state;
  state.laneRecovery = state.laneRecovery || [];
  state.laneRecovery.push({
    ts: entry.ts || new Date().toISOString(),
    laneName: String(entry.laneName || ''),
    role: String(entry.role || ''),
    attempt: Number(entry.attempt || 0),
    action: String(entry.action || 'continue'),
    reason: String(entry.reason || ''),
    fallbackRole: entry.fallbackRole || null,
    finalStatus: String(entry.finalStatus || 'unknown'),
    degraded: Boolean(entry.degraded),
  });
  return state;
}

/**
 * Append a `lane-timing` entry. Timings are used by the gantt visualizer to
 * draw lane execution windows. Each entry: { laneName, role, pattern?,
 * startMs (relative to goalStart), endMs (relative to goalStart), status,
 * attempt? }.
 */
function recordLaneTiming(state, entry) {
  if (!state) return state;
  state.laneTimings = state.laneTimings || [];
  state.laneTimings.push({
    laneName: String(entry.laneName || ''),
    role: String(entry.role || ''),
    pattern: entry.pattern || null,
    startMs: Number(entry.startMs) || 0,
    endMs: Number(entry.endMs) || 0,
    status: String(entry.status || 'done'),
    attempt: Number(entry.attempt || 0),
  });
  return state;
}

/**
 * Append a sub-goal result. The orchestrator runs sub-goals sequentially after
 * parent lanes; each sub-goal's outcome is summarized here so a parent's --show
 * can render the recursive picture without re-reading every sub state file.
 */
function recordSubGoalResult(state, summary) {
  if (!state) return state;
  state.subGoalResults = state.subGoalResults || [];
  state.subGoalResults.push({
    ts: summary.ts || new Date().toISOString(),
    subGoalId: String(summary.subGoalId || ''),
    template: summary.template || null,
    status: String(summary.status || 'unknown'),
    ok: Boolean(summary.ok),
    usd: Number(summary.usd || 0),
    callCount: Number(summary.callCount || 0),
    statePath: summary.statePath || null,
  });
  return state;
}

/**
 * Read a state file by direct path. The `readState` helper requires a goalId;
 * this variant is used by `--diff` and `--gantt` which take fully-qualified
 * paths so operators can point at exports without knowing the goalsDir.
 */
function readStateFromPath(p) {
  if (!fs.existsSync(p)) {
    throw new GoalStateError(`goal state not found at path: ${p}`, { path: p });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new GoalStateError(`goal state is not valid JSON: ${err.message}`, { path: p });
  }
  if (!parsed || typeof parsed !== 'object' || !ACCEPTED_SCHEMAS.has(parsed.schema)) {
    throw new GoalStateError('goal state file has wrong schema', { path: p, got: parsed && parsed.schema });
  }
  return upgradeStateInPlace(parsed);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/**
 * Render an ASCII gantt-style timeline of the lanes that ran for this goal.
 *
 * Layout: each row is `<lane-label-padded> | <bracket-bar>` where the bracket
 * bar's `[` is at the start time and `]` is at the end time, both proportional
 * to the goal's total wall time. Pattern lanes and simple lanes are both
 * surfaced; lanes that never ran are reported with a `(not-run)` marker.
 *
 * `opts.color` (default true) wraps brackets in green/red based on the lane's
 * final status. `opts.width` (default 60) is the bar width in characters.
 * `opts.now` is injected for tests.
 */
function renderGantt(state, opts = {}) {
  const width = Math.max(20, Math.min(160, Number(opts.width) || 60));
  const useColor = opts.color !== false;
  const lanes = Array.isArray(state.goal && state.goal.lanes) ? state.goal.lanes : [];
  const timings = Array.isArray(state.laneTimings) ? state.laneTimings : [];
  const timingByName = new Map(timings.map((t) => [t.laneName, t]));
  const maxEnd = timings.reduce((m, t) => Math.max(m, Number(t.endMs) || 0), 0) || 1;
  const labelWidth = lanes.reduce((m, l) => Math.max(m, String(l.name || '').length), 4);

  const ansi = (code, text) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

  const header = `goal: ${state.goalId} (${state.status})`;
  const subhdr = `total: ${maxEnd}ms across ${lanes.length} lane${lanes.length === 1 ? '' : 's'}`;
  const lines = [header, subhdr, ''];

  for (const lane of lanes) {
    const t = timingByName.get(lane.name);
    const label = String(lane.name).padEnd(labelWidth, ' ');
    if (!t) {
      lines.push(`${label} | ${'.'.repeat(width)} (not-run)`);
      continue;
    }
    const startCol = Math.max(0, Math.min(width - 1, Math.round((Number(t.startMs) / maxEnd) * (width - 1))));
    const endCol = Math.max(startCol, Math.min(width - 1, Math.round((Number(t.endMs) / maxEnd) * (width - 1))));
    const cells = [];
    for (let i = 0; i < width; i += 1) {
      if (i < startCol) cells.push(' ');
      else if (i === startCol) cells.push('[');
      else if (i === endCol) cells.push(']');
      else if (i > startCol && i < endCol) cells.push('=');
      else cells.push(' ');
    }
    const bar = cells.join('');
    const colored = t.status === 'failed' ? ansi('31', bar)
      : t.status === 'done' ? ansi('32', bar)
      : t.status === 'aborted' ? ansi('31', bar)
      : bar;
    const tag = `${t.startMs}..${t.endMs}ms ${t.status}`;
    lines.push(`${label} | ${colored} ${tag}`);
  }
  return lines.join('\n');
}

/**
 * Diff two goal-state objects. Returns `{ addedLanes, removedLanes,
 * changedLanes, addedSubGoals, removedSubGoals, costDelta, statusChanged }`.
 *
 * A "changed lane" is one whose timing status or final result.ok flipped
 * between the two states. Used by `openclaw goal --diff`.
 */
function diffStates(a, b) {
  if (!a || !b) throw new GoalStateError('diffStates requires two state objects');
  const aLanes = new Map(((a.goal && a.goal.lanes) || []).map((l) => [l.name, l]));
  const bLanes = new Map(((b.goal && b.goal.lanes) || []).map((l) => [l.name, l]));
  const aTimingByName = new Map((a.laneTimings || []).map((t) => [t.laneName, t]));
  const bTimingByName = new Map((b.laneTimings || []).map((t) => [t.laneName, t]));
  const addedLanes = [];
  const removedLanes = [];
  const changedLanes = [];
  for (const [name] of bLanes) {
    if (!aLanes.has(name)) addedLanes.push(name);
  }
  for (const [name] of aLanes) {
    if (!bLanes.has(name)) removedLanes.push(name);
    else {
      const aT = aTimingByName.get(name);
      const bT = bTimingByName.get(name);
      const aStatus = (aT && aT.status) || 'unknown';
      const bStatus = (bT && bT.status) || 'unknown';
      if (aStatus !== bStatus) {
        changedLanes.push({ name, from: aStatus, to: bStatus });
      }
    }
  }
  const aSub = new Set((a.subGoalResults || []).map((s) => s.subGoalId));
  const bSub = new Set((b.subGoalResults || []).map((s) => s.subGoalId));
  const addedSubGoals = [];
  const removedSubGoals = [];
  for (const s of bSub) if (!aSub.has(s)) addedSubGoals.push(s);
  for (const s of aSub) if (!bSub.has(s)) removedSubGoals.push(s);
  const aUsd = (a.cost && Number(a.cost.usd)) || 0;
  const bUsd = (b.cost && Number(b.cost.usd)) || 0;
  return {
    addedLanes,
    removedLanes,
    changedLanes,
    addedSubGoals,
    removedSubGoals,
    costDelta: Math.round((bUsd - aUsd) * 1_000_000) / 1_000_000,
    statusChanged: a.status !== b.status ? { from: a.status, to: b.status } : null,
  };
}

/**
 * Scan a ledger snapshot for a cancel-request that targets a specific goalId.
 *
 * Cancel-requests are recorded as `decision` records with
 * `decision === 'cancel-request'` and `taskId === goalId` (or the goalId as a
 * prefix). The first such record found wins.
 */
function findCancelRequest(records, goalId) {
  if (!Array.isArray(records)) return null;
  for (const r of records) {
    if (r.kind !== 'decision') continue;
    if (r.decision !== 'cancel-request') continue;
    if (r.taskId !== goalId) continue;
    return { ts: r.ts, agent: r.agent, rationale: r.rationale || '', recordId: r.id };
  }
  return null;
}

module.exports = {
  STATE_SCHEMA,
  STATE_SCHEMA_V1,
  ACCEPTED_SCHEMAS,
  GoalStateError,
  resolveGoalsDir,
  ensureDir,
  statePath,
  subGoalStatePath,
  subGoalDir,
  newState,
  readState,
  readSubGoalState,
  writeStateAtomic,
  writeSubGoalStateAtomic,
  listStates,
  listSubGoalStates,
  laneStatusFromResults,
  applyCallCost,
  recordError,
  recordLaneRecovery,
  recordLaneTiming,
  recordSubGoalResult,
  upgradeStateInPlace,
  readStateFromPath,
  renderGantt,
  diffStates,
  findCancelRequest,
  stripAnsi,
};
