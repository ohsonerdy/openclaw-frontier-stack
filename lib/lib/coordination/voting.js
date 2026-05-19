'use strict';

/**
 * voting.js — dispatch the same decision to multiple voters; collect a verdict.
 *
 * Pattern: a cross-role decision that needs N agents to weigh in. Each voter
 * gets the same prompt (`decision`) but in their own role lane, and writes a
 * `result` record with their vote in the summary string (and/or the `ok`
 * field). The coordinator counts approve / reject votes, applies a quorum
 * and threshold, and returns the verdict.
 *
 * Use cases:
 *   - "should we ship this release?" — require 3-of-4 approvals from
 *     security-sentinel, reviewer, architect, builder
 *   - "is this risk acceptable?" — quorum of 2-of-3 sentinels
 *   - "which of A/B/C wins?" — pluralty vote across N reviewers
 *
 * Vote interpretation: a voter's `result.ok === true` counts as APPROVE; any
 * other state (ok=false, missing, timed out) counts as REJECT. Optionally the
 * caller may pass a `voteFromResult` function that returns 'approve', 'reject',
 * 'abstain', or a custom label given the raw result record — for richer
 * multi-option ballots.
 *
 * Public API:
 *   voting({ goalId, decision, voters, ledger, taskflow, timeoutMs,
 *            pollIntervalMs, quorum, threshold, voteFromResult, mockVotes,
 *            now }) =>
 *     { ok, pattern, decided, verdict, votes, quorumMet, thresholdMet,
 *       durationMs }
 *
 * Parameters:
 *   goalId         (string)
 *   decision       (string) the prompt every voter receives
 *   voters         (array)  [{ id, role }, ...] one entry per voter
 *   ledger         (object) BlackboardLedger
 *   taskflow       (object) optional TaskFlowRuntime
 *   timeoutMs      (number) total budget (default 60s)
 *   pollIntervalMs (number) poll interval (default 200ms)
 *   quorum         (number) minimum voters whose results we need to consider
 *                           the vote valid (default = voters.length)
 *   threshold      (number) fraction of cast votes that must vote 'approve'
 *                           for the verdict to be 'approve' (default 0.5,
 *                           strict majority; use 2/3 ≈ 0.667 for super-
 *                           majority)
 *   voteFromResult (fn)     optional. (result) => 'approve' | 'reject' |
 *                           'abstain' | string. Default: ok→'approve' else
 *                           'reject'.
 *   mockVotes      (array)  optional [{ voterId, ok, summary, vote? }, ...]
 *                           for --mock-agents mode
 *   now            (fn)     time provider
 *
 * Return shape:
 *   { ok, pattern: 'voting', decided, verdict,
 *     votes: [{ voter, role, taskId, vote, ok, summary, signed_at }, ...],
 *     tally: { approve, reject, abstain, other },
 *     quorum, quorumMet, threshold, thresholdMet, durationMs }
 *
 * `decided` is true iff quorum was met. `verdict` is 'approve' iff
 * quorumMet AND thresholdMet, otherwise 'reject'. `ok` is `decided && verdict === 'approve'`.
 */

const ORCHESTRATOR_AGENT = 'orchestrator';

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

function defaultVoteFromResult(result) {
  return result && result.ok ? 'approve' : 'reject';
}

async function voting({
  goalId,
  decision,
  voters,
  ledger,
  taskflow = null,
  timeoutMs = 60000,
  pollIntervalMs = 200,
  quorum = null,
  threshold = 0.5,
  voteFromResult = defaultVoteFromResult,
  mockVotes = null,
  now = Date.now,
} = {}) {
  if (typeof goalId !== 'string' || !goalId.trim()) throw new Error('voting: goalId is required');
  if (typeof decision !== 'string' || !decision.trim()) throw new Error('voting: decision is required');
  if (!Array.isArray(voters) || voters.length === 0) throw new Error('voting: voters must be a non-empty array');
  if (!ledger || typeof ledger.claimTask !== 'function') throw new Error('voting: ledger must be a BlackboardLedger');

  const effectiveQuorum = quorum == null ? voters.length : Math.max(1, Math.min(voters.length, Number(quorum)));
  const effectiveThreshold = Math.max(0, Math.min(1, Number(threshold)));
  const overallStarted = now();

  const ballotByVoter = voters.map((voter, index) => {
    if (!voter || !voter.id || !voter.role) {
      throw new Error(`voting: voters[${index}] must have { id, role }`);
    }
    const taskId = `${goalId}.vote.${voter.id}`;
    const summary = `[${goalId}][vote] ${decision}`.slice(0, 500);
    ledger.claimTask({
      agent: ORCHESTRATOR_AGENT,
      taskId,
      summary,
    });
    if (taskflow) {
      try {
        taskflow.createTask({
          taskId,
          title: `vote: ${decision}`.slice(0, 200),
          owner: ORCHESTRATOR_AGENT,
          priority: 'normal',
          inputs: { goalId, pattern: 'voting', voterId: voter.id, role: voter.role, decision },
          dependsOn: [],
        });
        taskflow.claimTask({ taskId, agent: voter.role });
      } catch (err) { /* mirror only */ }
    }
    return { voterId: voter.id, role: voter.role, taskId };
  });

  if (Array.isArray(mockVotes) && mockVotes.length > 0) {
    for (const m of mockVotes) {
      const ballot = ballotByVoter.find((b) => b.voterId === m.voterId);
      if (!ballot) continue;
      ledger.recordResult({
        agent: ballot.role,
        taskId: ballot.taskId,
        ok: Boolean(m.ok),
        summary: String(m.summary || (m.ok ? 'approve' : 'reject')).slice(0, 1000),
        artifacts: m.artifacts || [],
      });
    }
  }

  const wantedIds = new Set(ballotByVoter.map((b) => b.taskId));
  let collected = new Map();
  while (true) {
    const snapshot = ledger.snapshot();
    collected = new Map();
    for (const r of snapshot.results) {
      if (wantedIds.has(r.taskId)) collected.set(r.taskId, r);
    }
    if (collected.size === wantedIds.size) break;
    if (now() - overallStarted >= timeoutMs) break;
    sleepSync(pollIntervalMs);
  }

  const votes = ballotByVoter.map((ballot) => {
    const r = collected.get(ballot.taskId);
    const vote = r ? voteFromResult(r) : 'missing';
    if (taskflow && r) {
      try {
        taskflow.completeTask({
          taskId: ballot.taskId,
          agent: ballot.role,
          status: r.ok ? 'ok' : 'failed',
          summary: r.summary,
          artifacts: r.artifacts || [],
        });
      } catch (err) { /* mirror only */ }
    }
    return {
      voter: ballot.voterId,
      role: ballot.role,
      taskId: ballot.taskId,
      vote,
      ok: r ? Boolean(r.ok) : false,
      summary: r ? r.summary : '',
      signed_at: r ? r.ts : null,
    };
  });

  const tally = { approve: 0, reject: 0, abstain: 0, missing: 0, other: 0 };
  let cast = 0;
  for (const v of votes) {
    if (v.vote === 'approve') { tally.approve += 1; cast += 1; }
    else if (v.vote === 'reject') { tally.reject += 1; cast += 1; }
    else if (v.vote === 'abstain') { tally.abstain += 1; cast += 1; }
    else if (v.vote === 'missing') { tally.missing += 1; }
    else { tally.other += 1; cast += 1; }
  }

  const quorumMet = cast >= effectiveQuorum;
  const denom = cast > 0 ? cast : 1;
  const approveShare = tally.approve / denom;
  const thresholdMet = approveShare >= effectiveThreshold;
  const decided = quorumMet;
  const verdict = decided && thresholdMet ? 'approve' : 'reject';

  return {
    ok: decided && verdict === 'approve',
    pattern: 'voting',
    decided,
    verdict,
    votes,
    tally,
    quorum: effectiveQuorum,
    quorumMet,
    threshold: effectiveThreshold,
    thresholdMet,
    durationMs: now() - overallStarted,
  };
}

module.exports = { voting };
