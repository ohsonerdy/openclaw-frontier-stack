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
 *
 * The directory lives relative to the blackboard's parent so the goal-state
 * directory and the blackboard ledger live next to each other and travel
 * together (a typical operator runs everything out of one repo root).
 *
 * No runtime deps. Pure Node.
 */

const fs = require('fs');
const path = require('path');

const STATE_SCHEMA = 'openclaw-frontier.goal-state.v1';

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

function newState({ goal, blackboardPath, options = {} }) {
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
  };
}

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
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== STATE_SCHEMA) {
    throw new GoalStateError('goal state file has wrong schema', { path: p, got: parsed && parsed.schema });
  }
  return parsed;
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

module.exports = {
  STATE_SCHEMA,
  GoalStateError,
  resolveGoalsDir,
  ensureDir,
  statePath,
  newState,
  readState,
  writeStateAtomic,
  listStates,
  laneStatusFromResults,
  applyCallCost,
  recordError,
};
