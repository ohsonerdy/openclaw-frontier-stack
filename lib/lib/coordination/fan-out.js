'use strict';

/**
 * fan-out.js — dispatch N independent tasks in parallel.
 *
 * Pattern: independent tasks that do not depend on each other. Each task gets
 * its own task-claim record on the blackboard; the coordinator polls until
 * every task has a matching result record (or until the budget elapses).
 *
 * Use cases:
 *   - have 5 agents review 5 separate files concurrently
 *   - run security-sentinel, reviewer, architect in parallel against the same
 *     change (none of them depends on the others' output)
 *   - distribute search across N corpora
 *
 * The coordinator sits ABOVE the blackboard primitive — it emits task-claim
 * records via `ledger.claimTask` and reads back via `ledger.snapshot()`. It
 * mirrors the dispatch into the optional TaskFlow runtime so callers can
 * inspect the FSM trace.
 *
 * In mock mode the caller is expected to inject result records itself (the
 * orchestrator's mock harness does this). The coordinator does not synthesize
 * results; it strictly waits for them.
 *
 * Public API:
 *   fanOut({ goalId, tasks, ledger, taskflow, timeoutMs, mockResults, now,
 *            pollIntervalMs }) => Promise<{
 *     ok, pattern, completed, failed, timedOut, claims, durationMs
 *   }>
 *
 * Parameters:
 *   goalId         (string)  used to namespace the dispatched task ids
 *   tasks          (array)   [{ id, role, summary, expects? }, ...]
 *   ledger         (object)  a BlackboardLedger instance
 *   taskflow       (object)  optional TaskFlowRuntime (mirror only)
 *   timeoutMs      (number)  hard budget for the entire fan-out (default 30s)
 *   pollIntervalMs (number)  ms between snapshot polls (default 200)
 *   mockResults    (array)   optional pre-baked [{ taskId, ok, summary }, ...]
 *                            written to the ledger before polling begins; used
 *                            by --mock-agents mode so the harness closes
 *                            without a live bus
 *
 * Return shape:
 *   { ok, pattern: 'fan-out',
 *     completed: [{ taskId, role, ok, summary, artifacts, ts }, ...],
 *     failed:    [{ taskId, role, ok: false, summary, artifacts, ts }, ...],
 *     timedOut:  [{ taskId, role, reason }, ...],
 *     claims:    [{ taskId, role, claimId, claimedAt }, ...],
 *     durationMs }
 *
 * `ok` is true iff every task produced a result with `ok: true`.
 */

const ORCHESTRATOR_AGENT = 'orchestrator';

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function buildTaskId(goalId, taskRef) {
  if (!taskRef || typeof taskRef !== 'object') {
    throw new Error('fanOut: each task must be an object with { id, role, summary }');
  }
  const id = String(taskRef.id || '').trim();
  if (!id) throw new Error('fanOut: task.id is required');
  return `${goalId}.${id}`;
}

function mirrorIntoTaskflow(taskflow, goalId, tasks, claims) {
  if (!taskflow) return;
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const claim = claims[i];
    try {
      taskflow.createTask({
        taskId: claim.taskId,
        title: task.summary,
        owner: ORCHESTRATOR_AGENT,
        priority: 'normal',
        inputs: { goalId, pattern: 'fan-out', role: task.role },
        dependsOn: [],
      });
      taskflow.claimTask({ taskId: claim.taskId, agent: task.role });
    } catch (err) {
      // FSM mirror is best-effort; the blackboard is the source of record
    }
  }
}

function recordResultsInTaskflow(taskflow, completed, failed) {
  if (!taskflow) return;
  const apply = (entry, status) => {
    try {
      taskflow.completeTask({
        taskId: entry.taskId,
        agent: entry.role,
        status,
        summary: entry.summary || `fan-out ${status}`,
        artifacts: entry.artifacts || [],
      });
    } catch (err) {
      // mirror only
    }
  };
  for (const entry of completed) apply(entry, 'ok');
  for (const entry of failed) apply(entry, 'failed');
}

async function fanOut({
  goalId,
  tasks,
  ledger,
  taskflow = null,
  timeoutMs = 30000,
  pollIntervalMs = 200,
  mockResults = null,
  now = Date.now,
} = {}) {
  if (typeof goalId !== 'string' || !goalId.trim()) throw new Error('fanOut: goalId is required');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('fanOut: tasks must be a non-empty array');
  if (!ledger || typeof ledger.claimTask !== 'function') throw new Error('fanOut: ledger must be a BlackboardLedger');

  const started = now();
  const claims = tasks.map((task) => {
    const taskId = buildTaskId(goalId, task);
    const claim = ledger.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary: `[${goalId}][fan-out] ${task.summary || task.id}`.slice(0, 500),
    });
    return {
      taskId,
      role: task.role,
      claimId: claim.id,
      claimedAt: claim.ts,
    };
  });
  mirrorIntoTaskflow(taskflow, goalId, tasks, claims);

  // Inject mock results for --mock-agents mode. The injector writes one result
  // per task to the ledger so the polling loop closes immediately.
  if (Array.isArray(mockResults) && mockResults.length > 0) {
    for (const mock of mockResults) {
      const claim = claims.find((c) => c.taskId === mock.taskId);
      if (!claim) continue;
      ledger.recordResult({
        agent: claim.role,
        taskId: claim.taskId,
        ok: Boolean(mock.ok),
        summary: String(mock.summary || `mock fan-out result for ${claim.taskId}`).slice(0, 1000),
        artifacts: mock.artifacts || [],
      });
    }
  }

  const wantedIds = new Set(claims.map((c) => c.taskId));
  let completed = [];
  let failed = [];
  let timedOut = [];

  while (true) {
    const snapshot = ledger.snapshot();
    const seen = new Map();
    for (const r of snapshot.results) {
      if (wantedIds.has(r.taskId)) seen.set(r.taskId, r);
    }
    completed = [];
    failed = [];
    for (const claim of claims) {
      const r = seen.get(claim.taskId);
      if (!r) continue;
      const entry = {
        taskId: claim.taskId,
        role: claim.role,
        ok: Boolean(r.ok),
        summary: r.summary,
        artifacts: r.artifacts || [],
        ts: r.ts,
      };
      if (r.ok) completed.push(entry);
      else failed.push(entry);
    }
    const resolvedCount = completed.length + failed.length;
    if (resolvedCount === claims.length) {
      recordResultsInTaskflow(taskflow, completed, failed);
      return {
        ok: failed.length === 0,
        pattern: 'fan-out',
        completed,
        failed,
        timedOut: [],
        claims,
        durationMs: now() - started,
      };
    }
    if (now() - started >= timeoutMs) {
      timedOut = claims
        .filter((c) => !seen.has(c.taskId))
        .map((c) => ({ taskId: c.taskId, role: c.role, reason: 'no result before fan-out timeout' }));
      recordResultsInTaskflow(taskflow, completed, failed);
      return {
        ok: false,
        pattern: 'fan-out',
        completed,
        failed,
        timedOut,
        claims,
        durationMs: now() - started,
      };
    }
    sleepSync(pollIntervalMs);
  }
}

module.exports = { fanOut };
