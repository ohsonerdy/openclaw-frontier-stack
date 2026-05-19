'use strict';

/**
 * subagent.js — parent agent delegates N parallel children with scoped writes.
 *
 * Pattern: the parent (already running as some role) needs to fan a problem
 * out to N short-lived child agents that share a custom sub-role and a
 * restricted view of the blackboard. Each child runs under its own
 * `subagent:<parentGoalId>:<index>` scope; the parent sees only the children's
 * final result records, never their intermediate facts/decisions.
 *
 * Two execution modes:
 *   - `workers` (default): in-process `worker_threads`. Cheap, ideal for
 *     tests and CPU-bound child handlers. The handler runs in the worker; the
 *     parent receives a result message and writes the result record itself
 *     under the child's scope.
 *   - `processes`: spawn `openclaw-agent --role <role> --task-id <id>
 *     --scope <scope>` as a child process. The agent binary writes its own
 *     result record to a child-scoped ledger slice; the parent reads it back.
 *
 * Scope isolation:
 *   The parent constructs a `scopedLedger` adapter for each child. That
 *   adapter wraps the real ledger and REJECTS any write whose `scope` field
 *   does not match the child's assigned slice. Intermediate fact/decision
 *   records the child writes carry that scope and stay invisible to the
 *   parent's snapshot. Only the single `result` record per child is lifted
 *   into the parent's view via `parentResults`.
 *
 * Public API:
 *   subagentFanOut({ parent, role, tasks, blackboard, agentBin, mode,
 *                    handler, timeoutMs, taskflow, now }) =>
 *     Promise<{
 *       ok, pattern: 'subagent',
 *       results: [{ taskId, scope, ok, summary, artifacts, ts }, ...],
 *       failed:  [{ taskId, scope, error }, ...],
 *       timedOut:[{ taskId, scope }, ...],
 *       parentResults: <function() => result[]>,  // filtered view
 *       childScopes: [scope, ...],
 *       durationMs,
 *     }>
 *
 * `ok` is true iff every child returned a result with `ok: true` and no
 * child timed out or errored.
 */

const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

const ORCHESTRATOR_AGENT = 'orchestrator';
const SUBAGENT_RESULT_KIND = 'result';
const SUBAGENT_FACT_KIND = 'fact';

class SubagentScopeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SubagentScopeError';
    this.code = 'SUBAGENT_SCOPE_VIOLATION';
    this.details = details;
  }
}

function buildScope(parentGoalId, index) {
  return `subagent:${parentGoalId}:${index}`;
}

function buildChildTaskId(parentGoalId, taskRef, index) {
  if (!taskRef || typeof taskRef !== 'object') {
    throw new Error('subagentFanOut: each task must be an object with { id, summary }');
  }
  const id = String(taskRef.id || '').trim();
  if (!id) throw new Error('subagentFanOut: task.id is required');
  return `${parentGoalId}.sub.${index}.${id}`;
}

/**
 * Wrap the real ledger so that every write checks the record's `scope` field
 * against the child's assigned slice. Anything else throws a scope error.
 * The wrapper only exposes the methods a child legitimately needs: fact,
 * decision, result. Path/task claims are not allowed from a child here.
 */
function createScopedLedger(realLedger, allowedScope, childAgent) {
  if (typeof allowedScope !== 'string' || !allowedScope.startsWith('subagent:')) {
    throw new SubagentScopeError('scopedLedger: allowedScope must look like subagent:<goal>:<idx>', {
      allowedScope,
    });
  }
  function assertScope(record, label) {
    if (!record || typeof record !== 'object') {
      throw new SubagentScopeError(`${label}: record must be an object`);
    }
    if (record.scope !== allowedScope) {
      throw new SubagentScopeError(`${label}: scope must equal ${allowedScope}`, {
        allowedScope,
        attemptedScope: record.scope || null,
      });
    }
  }
  return {
    allowedScope,
    childAgent,
    recordFact({ subject, value, evidence = [], scope }) {
      assertScope({ scope }, 'scopedLedger.recordFact');
      return realLedger.recordFact({
        agent: childAgent,
        subject: `[${allowedScope}] ${String(subject || '').slice(0, 160)}`,
        value: value == null ? null : value,
        evidence: evidence || [],
      });
    },
    recordDecision({ taskId = '', decision, status = 'accepted', rationale = '', scope }) {
      assertScope({ scope }, 'scopedLedger.recordDecision');
      const args = {
        agent: childAgent,
        decision: `[${allowedScope}] ${String(decision || '').slice(0, 160)}`,
        status,
        rationale: rationale || '',
      };
      if (taskId) args.taskId = taskId;
      return realLedger.recordDecision(args);
    },
    recordResult({ taskId, ok, summary, artifacts = [], scope }) {
      assertScope({ scope }, 'scopedLedger.recordResult');
      return realLedger.recordResult({
        agent: childAgent,
        taskId,
        ok: Boolean(ok),
        summary: `[${allowedScope}] ${String(summary || '').slice(0, 900)}`,
        artifacts: artifacts || [],
      });
    },
  };
}

/**
 * Run one handler in a worker thread. The worker code is inlined as a small
 * `eval` string so we don't have to ship a separate worker file. The handler
 * function is serialized via .toString() and re-evaluated inside the worker;
 * it must be pure (no closure dependencies).
 */
function runWorker({ scope, taskId, role, task, handlerSource, timeoutMs }) {
  return new Promise((resolve) => {
    const workerSrc = `
      'use strict';
      const { parentPort, workerData } = require('worker_threads');
      (async () => {
        try {
          const handler = eval('(' + workerData.handlerSource + ')');
          const out = await handler({
            scope: workerData.scope,
            taskId: workerData.taskId,
            role: workerData.role,
            task: workerData.task,
          });
          parentPort.postMessage({ ok: true, value: out });
        } catch (err) {
          parentPort.postMessage({
            ok: false,
            error: String(err && err.message ? err.message : err),
          });
        }
      })();
    `;
    const worker = new Worker(workerSrc, {
      eval: true,
      workerData: { scope, taskId, role, task, handlerSource },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch (_) { /* worker may be gone */ }
      resolve({ ok: false, timedOut: true, error: 'child worker timed out' });
    }, Math.max(1, timeoutMs));
    worker.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      resolve({ ok: Boolean(msg && msg.ok), timedOut: false, value: msg && msg.value, error: msg && msg.error });
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      resolve({ ok: false, timedOut: false, error: String(err && err.message ? err.message : err) });
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, timedOut: false, error: `worker exited with code ${code}` });
      } else {
        resolve({ ok: false, timedOut: false, error: 'worker exited before posting a message' });
      }
    });
  });
}

/**
 * Spawn `openclaw-agent --role <role> --task-id <id> --scope <scope>` as a
 * short-lived child process. The agent binary handles its own scope-aware
 * writes via the BlackboardLedger; we just wait for the process to exit and
 * then read the result record off the parent's snapshot view.
 */
function runProcess({ scope, taskId, role, agentBin, blackboardPath, extraArgs, timeoutMs }) {
  return new Promise((resolve) => {
    const args = [
      '--role', role,
      '--task-id', taskId,
      '--scope', scope,
      '--blackboard', blackboardPath,
      '--once',
      ...(Array.isArray(extraArgs) ? extraArgs : []),
    ];
    const child = spawn(process.execPath, [agentBin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve({ ok: false, timedOut: true, error: 'child process timed out' });
    }, Math.max(1, timeoutMs));
    let stderr = '';
    child.stderr && child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, error: String(err && err.message ? err.message : err) });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, timedOut: false, value: { exitCode: code } });
      } else {
        resolve({ ok: false, timedOut: false, error: `agent exit ${code}: ${stderr.slice(0, 400)}` });
      }
    });
  });
}

function mirrorTaskflow(taskflow, parent, claims) {
  if (!taskflow) return;
  for (const claim of claims) {
    try {
      taskflow.createTask({
        taskId: claim.taskId,
        title: claim.summary,
        owner: ORCHESTRATOR_AGENT,
        priority: 'normal',
        inputs: { parentGoalId: parent, pattern: 'subagent', scope: claim.scope, role: claim.role },
        dependsOn: [],
      });
      taskflow.claimTask({ taskId: claim.taskId, agent: claim.role });
    } catch (_) { /* mirror only */ }
  }
}

function completeTaskflow(taskflow, entry, role, status) {
  if (!taskflow) return;
  try {
    taskflow.completeTask({
      taskId: entry.taskId,
      agent: role,
      status,
      summary: entry.summary || `subagent ${status}`,
      artifacts: entry.artifacts || [],
    });
  } catch (_) { /* mirror only */ }
}

/**
 * Build the parent-visible filter. Given the real ledger snapshot, return
 * only result records whose taskId is one of the child task ids. Intermediate
 * fact/decision records carrying the child scope are filtered out (they're
 * still on the ledger for audit; the parent's view just ignores them).
 */
function makeParentResultsView(realLedger, childTaskIdSet) {
  return function parentResults() {
    const snapshot = realLedger.snapshot();
    return snapshot.results.filter((r) => childTaskIdSet.has(r.taskId));
  };
}

async function subagentFanOut({
  parent,
  role,
  tasks,
  blackboard,
  agentBin = null,
  mode = 'workers',
  handler = null,
  timeoutMs = 5000,
  taskflow = null,
  extraArgs = [],
  now = Date.now,
} = {}) {
  if (typeof parent !== 'string' || !parent.trim()) {
    throw new Error('subagentFanOut: parent (parentGoalId) is required');
  }
  if (typeof role !== 'string' || !role.trim()) {
    throw new Error('subagentFanOut: role is required');
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('subagentFanOut: tasks must be a non-empty array');
  }
  if (!blackboard || typeof blackboard.claimTask !== 'function') {
    throw new Error('subagentFanOut: blackboard must be a BlackboardLedger');
  }
  if (mode !== 'workers' && mode !== 'processes') {
    throw new Error(`subagentFanOut: mode must be 'workers' or 'processes' (got ${mode})`);
  }
  if (mode === 'workers' && typeof handler !== 'function') {
    throw new Error('subagentFanOut: handler is required in workers mode');
  }
  if (mode === 'processes' && (!agentBin || typeof agentBin !== 'string')) {
    throw new Error('subagentFanOut: agentBin path is required in processes mode');
  }

  const started = now();
  const handlerSource = handler ? handler.toString() : null;

  const claims = tasks.map((task, index) => {
    const scope = buildScope(parent, index);
    const taskId = buildChildTaskId(parent, task, index);
    const summary = `[${parent}][subagent ${index + 1}/${tasks.length}] ${task.summary || task.id}`.slice(0, 500);
    blackboard.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary,
      forRole: role,
    });
    return { taskId, scope, role, index, task, summary };
  });
  mirrorTaskflow(taskflow, parent, claims);

  // Each child gets its own scoped ledger adapter. We expose this on the
  // returned trace so tests (and the agentBin in processes mode) can confirm
  // that out-of-scope writes are rejected.
  const childAdapters = claims.map((claim) => ({
    scope: claim.scope,
    taskId: claim.taskId,
    adapter: createScopedLedger(blackboard, claim.scope, role),
  }));

  // Fan the work out. We do not poll the ledger for results in workers mode
  // — the worker returns the value to us synchronously and the parent writes
  // the result record under the child's scope. In processes mode the agent
  // binary writes the result; we wait for the process exit then read back.
  const childTaskIdSet = new Set(claims.map((c) => c.taskId));
  const childPromises = claims.map(async (claim, index) => {
    if (mode === 'workers') {
      const outcome = await runWorker({
        scope: claim.scope,
        taskId: claim.taskId,
        role,
        task: claim.task,
        handlerSource,
        timeoutMs,
      });
      if (outcome.timedOut) {
        return { status: 'timed-out', claim, outcome };
      }
      if (!outcome.ok) {
        return { status: 'failed', claim, outcome };
      }
      const value = outcome.value || {};
      // The parent writes the result record under the child's scope on the
      // child's behalf, going through the scoped adapter so any tampering
      // (a handler returning a record with a forged scope) is caught here.
      try {
        childAdapters[index].adapter.recordResult({
          taskId: claim.taskId,
          ok: Boolean(value.ok),
          summary: String(value.summary || `subagent ${claim.taskId} returned`).slice(0, 900),
          artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
          scope: claim.scope,
        });
      } catch (err) {
        return { status: 'failed', claim, outcome: { ok: false, error: String(err.message || err) } };
      }
      // Optionally also let the worker emit intermediate facts via its return
      // value. These stay on the ledger but are filtered out of the parent
      // results view.
      if (Array.isArray(value.facts)) {
        for (const fact of value.facts) {
          try {
            childAdapters[index].adapter.recordFact({
              subject: String(fact.subject || 'subagent-intermediate').slice(0, 160),
              value: fact.value == null ? null : fact.value,
              evidence: fact.evidence || [],
              scope: claim.scope,
            });
          } catch (_) { /* intermediate facts are best-effort */ }
        }
      }
      return { status: value.ok ? 'done' : 'failed', claim, outcome, value };
    }
    // mode === 'processes'
    const outcome = await runProcess({
      scope: claim.scope,
      taskId: claim.taskId,
      role,
      agentBin,
      blackboardPath: blackboard.ledgerPath,
      extraArgs,
      timeoutMs,
    });
    if (outcome.timedOut) return { status: 'timed-out', claim, outcome };
    if (!outcome.ok) return { status: 'failed', claim, outcome };
    // In process mode the agent wrote the result itself; locate it.
    const snapshot = blackboard.snapshot();
    const result = snapshot.results.find((r) => r.taskId === claim.taskId);
    if (!result) {
      return { status: 'failed', claim, outcome: { ok: false, error: 'agent exited 0 but wrote no result' } };
    }
    return { status: result.ok ? 'done' : 'failed', claim, outcome, result };
  });

  const settled = await Promise.all(childPromises);

  const results = [];
  const failed = [];
  const timedOut = [];
  for (const entry of settled) {
    const claim = entry.claim;
    if (entry.status === 'timed-out') {
      timedOut.push({ taskId: claim.taskId, scope: claim.scope });
      completeTaskflow(taskflow, { taskId: claim.taskId, summary: 'timed-out', artifacts: [] }, role, 'failed');
      continue;
    }
    if (entry.status === 'failed') {
      const err = (entry.outcome && entry.outcome.error) || (entry.result && entry.result.summary) || 'child failed';
      failed.push({ taskId: claim.taskId, scope: claim.scope, error: String(err).slice(0, 400) });
      completeTaskflow(taskflow, { taskId: claim.taskId, summary: String(err).slice(0, 400), artifacts: [] }, role, 'failed');
      continue;
    }
    // status === 'done'
    const snap = blackboard.snapshot();
    const r = snap.results.find((rec) => rec.taskId === claim.taskId);
    const entryResult = r
      ? {
          taskId: claim.taskId,
          scope: claim.scope,
          ok: Boolean(r.ok),
          summary: r.summary,
          artifacts: r.artifacts || [],
          ts: r.ts,
        }
      : {
          taskId: claim.taskId,
          scope: claim.scope,
          ok: true,
          summary: 'child completed but result not yet visible on ledger',
          artifacts: [],
          ts: null,
        };
    results.push(entryResult);
    completeTaskflow(taskflow, entryResult, role, entryResult.ok ? 'ok' : 'failed');
  }

  const ok = failed.length === 0 && timedOut.length === 0 && results.every((r) => r.ok);

  return {
    ok,
    pattern: 'subagent',
    results,
    failed,
    timedOut,
    parentResults: makeParentResultsView(blackboard, childTaskIdSet),
    childScopes: claims.map((c) => c.scope),
    childTaskIds: claims.map((c) => c.taskId),
    durationMs: now() - started,
  };
}

module.exports = {
  subagentFanOut,
  createScopedLedger,
  SubagentScopeError,
  // exported for tests that want to introspect the naming convention
  __test__: { buildScope, buildChildTaskId },
};
