'use strict';

/**
 * chain.js — sequential pipeline. Step N+1 sees Step N's result.
 *
 * Pattern: each step strictly depends on the previous step's output. The
 * coordinator dispatches one task at a time, waits for its result, then
 * dispatches the next. The next step's summary references the prior step's
 * taskId so the live agent can fetch the upstream artifact off the ledger.
 *
 * If any step fails (result.ok === false) or times out, the chain short-
 * circuits — subsequent steps are NOT dispatched and the trace records them
 * as "skipped".
 *
 * Use cases:
 *   - research → spec → review-spec → build → review-build
 *   - extract → normalize → validate → emit
 *   - draft → critique → revise → ship
 *
 * Public API:
 *   chain({ goalId, steps, ledger, taskflow, timeoutMs, pollIntervalMs,
 *           mockResults, now }) =>
 *     { ok, pattern, steps, completedCount, durationMs }
 *
 * Parameters:
 *   goalId         (string)
 *   steps          (array)  [{ id, role, summary, expects? }, ...] in order
 *   ledger         (object) BlackboardLedger
 *   taskflow       (object) optional TaskFlowRuntime
 *   timeoutMs      (number) per-step budget (default 30s)
 *   pollIntervalMs (number) ms between polls (default 200)
 *   mockResults    (array)  optional [{ stepId, ok, summary }, ...] keyed by
 *                           step.id; consumed in order for --mock-agents mode
 *   now            (fn)     time provider
 *
 * Return shape:
 *   { ok, pattern: 'chain',
 *     steps: [
 *       { id, role, taskId, status, ok, summary, artifacts, ts }, ...
 *     ],
 *     completedCount, durationMs }
 *
 * Each step's status is one of: 'done', 'failed', 'timed-out', 'skipped'.
 * `ok` is true iff every step in the chain reached 'done'.
 */

const ORCHESTRATOR_AGENT = 'orchestrator';

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function waitForResult(ledger, taskId, timeoutMs, pollIntervalMs, now) {
  const started = now();
  while (true) {
    const snapshot = ledger.snapshot();
    const result = snapshot.results.find((r) => r.taskId === taskId);
    if (result) return { result, timedOut: false };
    if (now() - started >= timeoutMs) return { result: null, timedOut: true };
    sleepSync(pollIntervalMs);
  }
}

async function chain({
  goalId,
  steps,
  ledger,
  taskflow = null,
  timeoutMs = 30000,
  pollIntervalMs = 200,
  mockResults = null,
  now = Date.now,
} = {}) {
  if (typeof goalId !== 'string' || !goalId.trim()) throw new Error('chain: goalId is required');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('chain: steps must be a non-empty array');
  if (!ledger || typeof ledger.claimTask !== 'function') throw new Error('chain: ledger must be a BlackboardLedger');

  const overallStarted = now();
  const trace = steps.map((step) => ({
    id: step.id,
    role: step.role,
    taskId: null,
    status: 'pending',
    ok: false,
    summary: '',
    artifacts: [],
    ts: null,
  }));

  const mockByStep = new Map();
  if (Array.isArray(mockResults)) {
    for (const m of mockResults) mockByStep.set(m.stepId, m);
  }

  let priorTaskId = null;
  let priorSummary = null;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const entry = trace[i];
    if (!step.id || !step.role) {
      entry.status = 'failed';
      entry.summary = 'chain: step.id and step.role are required';
      return finalize(trace, false, overallStarted, now);
    }
    const taskId = `${goalId}.${step.id}`;
    entry.taskId = taskId;
    const stepSummary = priorTaskId
      ? `[${goalId}][chain ${i + 1}/${steps.length}] ${step.summary || step.id} (input from ${priorTaskId}: ${priorSummary ? priorSummary.slice(0, 80) : ''})`
      : `[${goalId}][chain ${i + 1}/${steps.length}] ${step.summary || step.id}`;
    ledger.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary: stepSummary.slice(0, 500),
    });
    if (taskflow) {
      try {
        taskflow.createTask({
          taskId,
          title: step.summary || step.id,
          owner: ORCHESTRATOR_AGENT,
          priority: 'normal',
          inputs: { goalId, pattern: 'chain', step: i + 1, of: steps.length, prior: priorTaskId },
          dependsOn: priorTaskId ? [priorTaskId] : [],
        });
        taskflow.claimTask({ taskId, agent: step.role });
      } catch (err) { /* mirror only */ }
    }

    const mock = mockByStep.get(step.id);
    if (mock) {
      ledger.recordResult({
        agent: step.role,
        taskId,
        ok: Boolean(mock.ok),
        summary: String(mock.summary || `mock chain step ${step.id}`).slice(0, 1000),
        artifacts: mock.artifacts || [],
      });
    }

    const { result, timedOut } = waitForResult(ledger, taskId, timeoutMs, pollIntervalMs, now);
    if (timedOut || !result) {
      entry.status = 'timed-out';
      entry.summary = 'no result before per-step timeout';
      for (let j = i + 1; j < steps.length; j += 1) {
        trace[j].status = 'skipped';
        trace[j].summary = `skipped because step ${step.id} timed out`;
      }
      return finalize(trace, false, overallStarted, now);
    }
    entry.ok = Boolean(result.ok);
    entry.status = result.ok ? 'done' : 'failed';
    entry.summary = result.summary;
    entry.artifacts = result.artifacts || [];
    entry.ts = result.ts;
    if (taskflow) {
      try {
        taskflow.completeTask({
          taskId,
          agent: step.role,
          status: result.ok ? 'ok' : 'failed',
          summary: result.summary,
          artifacts: result.artifacts || [],
        });
      } catch (err) { /* mirror only */ }
    }
    if (!result.ok) {
      for (let j = i + 1; j < steps.length; j += 1) {
        trace[j].status = 'skipped';
        trace[j].summary = `skipped because step ${step.id} failed`;
      }
      return finalize(trace, false, overallStarted, now);
    }
    priorTaskId = taskId;
    priorSummary = result.summary;
  }

  return finalize(trace, true, overallStarted, now);
}

function finalize(trace, ok, overallStarted, now) {
  const completedCount = trace.filter((e) => e.status === 'done').length;
  return {
    ok,
    pattern: 'chain',
    steps: trace,
    completedCount,
    durationMs: now() - overallStarted,
  };
}

module.exports = { chain };
