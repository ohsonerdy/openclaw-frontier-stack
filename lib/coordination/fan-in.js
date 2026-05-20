'use strict';

/**
 * fan-in.js — wait for N upstream tasks to complete, then dispatch a joiner.
 *
 * Pattern: a join point that needs the union of N upstream results to do its
 * work. The coordinator does NOT dispatch the upstream tasks itself — it
 * assumes the caller already dispatched them (typically via a prior fan-out)
 * and just waits for their results. When all upstream results are present,
 * the joiner task-claim is written; its summary includes a compact reference
 * to the upstream taskIds so the joiner agent can look them up on the
 * blackboard.
 *
 * Use cases:
 *   - synthesize 5 reviewers' verdicts into a single recommendation
 *   - aggregate per-shard search results
 *   - merge per-file diffs into one PR description
 *
 * Public API:
 *   fanIn({ goalId, sourceTaskIds, joiner, ledger, taskflow, timeoutMs,
 *           pollIntervalMs, mockJoinerResult, now }) => Promise<{
 *     ok, pattern, upstream, joiner, durationMs
 *   }>
 *
 * `ok` is true iff every upstream task completed with ok=true AND the joiner
 * completed with ok=true. If any upstream is missing, the joiner is NOT
 * dispatched.
 */

const ORCHESTRATOR_AGENT = 'orchestrator';

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function pollUpstream(ledger, sourceTaskIds, timeoutMs, pollIntervalMs, now) {
  const started = now();
  const wanted = new Set(sourceTaskIds);
  while (true) {
    const snapshot = ledger.snapshot();
    const seen = new Map();
    for (const r of snapshot.results) {
      if (wanted.has(r.taskId)) seen.set(r.taskId, r);
    }
    if (seen.size === wanted.size) {
      return { ok: true, found: seen, missing: [], elapsedMs: now() - started };
    }
    if (now() - started >= timeoutMs) {
      const missing = [...wanted].filter((id) => !seen.has(id));
      return { ok: false, found: seen, missing, elapsedMs: now() - started };
    }
    sleepSync(pollIntervalMs);
  }
}

function pollJoiner(ledger, taskId, timeoutMs, pollIntervalMs, now) {
  const started = now();
  while (true) {
    const snapshot = ledger.snapshot();
    const result = snapshot.results.find((r) => r.taskId === taskId);
    if (result) return { result, elapsedMs: now() - started };
    if (now() - started >= timeoutMs) return { result: null, elapsedMs: now() - started };
    sleepSync(pollIntervalMs);
  }
}

async function fanIn({
  goalId,
  sourceTaskIds,
  joiner,
  ledger,
  taskflow = null,
  timeoutMs = 60000,
  pollIntervalMs = 200,
  mockJoinerResult = null,
  now = Date.now,
} = {}) {
  if (typeof goalId !== 'string' || !goalId.trim()) throw new Error('fanIn: goalId is required');
  if (!Array.isArray(sourceTaskIds) || sourceTaskIds.length === 0) throw new Error('fanIn: sourceTaskIds must be a non-empty array');
  if (!joiner || typeof joiner !== 'object') throw new Error('fanIn: joiner must be an object');
  if (!joiner.id || !joiner.role) throw new Error('fanIn: joiner.id and joiner.role are required');
  if (!ledger || typeof ledger.claimTask !== 'function') throw new Error('fanIn: ledger must be a BlackboardLedger');

  const overallStarted = now();
  const upstream = pollUpstream(ledger, sourceTaskIds, timeoutMs, pollIntervalMs, now);
  if (!upstream.ok) {
    return {
      ok: false,
      pattern: 'fan-in',
      upstream: {
        complete: [...upstream.found.values()].map((r) => ({ taskId: r.taskId, ok: r.ok, summary: r.summary, agent: r.agent })),
        missing: upstream.missing.map((taskId) => ({ taskId, reason: 'no upstream result before fan-in timeout' })),
      },
      joiner: { taskId: null, role: joiner.role, dispatched: false, claimId: null, result: null },
      durationMs: now() - overallStarted,
    };
  }

  const upstreamOk = [...upstream.found.values()].every((r) => r.ok);
  const joinerTaskId = `${goalId}.${joiner.id}`;
  const upstreamRefs = [...upstream.found.values()].map((r) => r.taskId).join(',');
  const joinerSummary = `[${goalId}][fan-in] ${joiner.summary || joiner.id} (sources: ${upstreamRefs})`.slice(0, 500);

  const claim = ledger.claimTask({
    agent: ORCHESTRATOR_AGENT,
    taskId: joinerTaskId,
    summary: joinerSummary,
  });

  if (taskflow) {
    try {
      taskflow.createTask({
        taskId: joinerTaskId,
        title: joiner.summary || joiner.id,
        owner: ORCHESTRATOR_AGENT,
        priority: 'normal',
        inputs: { goalId, pattern: 'fan-in', role: joiner.role, sources: sourceTaskIds },
        dependsOn: sourceTaskIds,
      });
      taskflow.claimTask({ taskId: joinerTaskId, agent: joiner.role });
    } catch (err) { /* mirror only */ }
  }

  // Mock-mode: synthesize the joiner's result so polling closes immediately.
  if (mockJoinerResult) {
    ledger.recordResult({
      agent: joiner.role,
      taskId: joinerTaskId,
      ok: Boolean(mockJoinerResult.ok),
      summary: String(mockJoinerResult.summary || `mock fan-in joiner result for ${joinerTaskId}`).slice(0, 1000),
      artifacts: mockJoinerResult.artifacts || [],
    });
  }

  const remainingMs = Math.max(1, timeoutMs - (now() - overallStarted));
  const { result } = pollJoiner(ledger, joinerTaskId, remainingMs, pollIntervalMs, now);

  if (taskflow && result) {
    try {
      taskflow.completeTask({
        taskId: joinerTaskId,
        agent: joiner.role,
        status: result.ok ? 'ok' : 'failed',
        summary: result.summary,
        artifacts: result.artifacts || [],
      });
    } catch (err) { /* mirror only */ }
  }

  return {
    ok: upstreamOk && Boolean(result && result.ok),
    pattern: 'fan-in',
    upstream: {
      complete: [...upstream.found.values()].map((r) => ({ taskId: r.taskId, ok: r.ok, summary: r.summary, agent: r.agent })),
      missing: [],
    },
    joiner: {
      taskId: joinerTaskId,
      role: joiner.role,
      dispatched: true,
      claimId: claim.id,
      result: result ? { ok: result.ok, summary: result.summary, agent: result.agent, ts: result.ts, artifacts: result.artifacts || [] } : null,
    },
    durationMs: now() - overallStarted,
  };
}

module.exports = { fanIn };
