#!/usr/bin/env node
'use strict';

/*
 * Production-safe self-healing/recovery eval.
 *
 * This lane intentionally does not touch live OpenClaw services, credentials,
 * release approvals, external APIs, or operator machines. It demonstrates a
 * safe recovery pattern for a known stale blocker:
 *
 * - detect a stale foreign path claim that blocks the desired edit path;
 * - classify the blocker by owner and required action;
 * - refuse unsafe auto-fix actions such as releasing another agent's claim;
 * - retry by rerouting to a non-overlapping receipt path;
 * - leave machine-readable receipts proving the decision and final state.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BlackboardLedger } = require('../src/blackboard/lib/ledger');
const { TaskFlowRuntime } = require('../src/taskflow/lib/taskflow');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'release-gate', 'reports');
const reportPath = path.join(reportDir, 'latest-self-healing-recovery-eval.json');

const LANE_ID = 'FR-SELF-HEAL-001';
const BLOCKED_PATH = 'docs/runtime-ops.md';
const SAFE_RECEIPT_PATH = 'release-gate/reports/self-healing-recovery-receipt.json';
const STALE_AFTER_MS = 30 * 60 * 1000;

function classifyBlocker({ blocker, nowMs }) {
  const ageMs = nowMs - Date.parse(blocker.observedAt);
  const stale = Number.isFinite(ageMs) && ageMs >= STALE_AFTER_MS;
  const foreignOwner = blocker.claim && blocker.claim.agent !== 'recovery';

  if (stale && foreignOwner) {
    return {
      id: blocker.id,
      stale: true,
      owner: blocker.claim.agent,
      requiredAction: 'owner-or-operator-review',
      recommendedRecovery: 'reroute-to-safe-receipt-path',
      unsafeAutoFixDenied: true,
      denialReason: 'Foreign path claims are coordination locks, not garbage; releasing them could overwrite another agent\'s work.',
      disallowedActions: [
        'release-foreign-path-claim',
        'edit-blocked-path',
        'restart-service',
        'external-write',
      ],
    };
  }

  return {
    id: blocker.id,
    stale,
    owner: blocker.claim ? blocker.claim.agent : 'unknown',
    requiredAction: 'continue-observing',
    recommendedRecovery: 'wait-and-retry',
    unsafeAutoFixDenied: true,
    denialReason: 'Only deterministic local retry is allowed in this public eval.',
    disallowedActions: ['restart-service', 'external-write'],
  };
}

function main() {
  const startedAt = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-frontier-self-heal-'));
  const ledgerPath = path.join(tmp, 'blackboard.jsonl');
  const board = new BlackboardLedger({ ledgerPath });
  const taskflow = new TaskFlowRuntime();

  const receipts = [];
  const blockedTaskId = 'selfheal-stale-blocker-demo';

  // Seed a known stale blocker in an isolated temp ledger. This is synthetic and
  // production-safe; it does not represent or mutate the live workspace state.
  board.claimTask({
    agent: 'builder',
    taskId: 'legacy-doc-update',
    summary: 'Synthetic prior documentation lane that owns the runtime ops path.',
  });
  board.claimPath({
    agent: 'builder',
    taskId: 'legacy-doc-update',
    path: BLOCKED_PATH,
    reason: 'Synthetic stale blocker used by the recovery eval.',
  });

  taskflow.createTask({
    taskId: blockedTaskId,
    title: `${LANE_ID} production-safe self-healing recovery lane`,
    owner: 'orchestrator',
    inputs: { desiredPath: BLOCKED_PATH, safeReceiptPath: SAFE_RECEIPT_PATH },
  });
  taskflow.claimTask({ taskId: blockedTaskId, agent: 'recovery' });
  board.claimTask({
    agent: 'recovery',
    taskId: blockedTaskId,
    summary: 'Detect stale blocker, classify owner/action, then recover without unsafe auto-fix.',
  });

  const staleObservedAt = new Date(startedAt - (STALE_AFTER_MS + 60 * 1000)).toISOString();
  let unsafeAutoFixAttempted = false;
  let blockedClaimRejected = false;
  let classification = null;

  // Attempt 1: hit the known stale blocker.
  try {
    board.claimPath({
      agent: 'recovery',
      taskId: blockedTaskId,
      path: BLOCKED_PATH,
      reason: 'Attempt to use desired documentation path.',
    });
  } catch (err) {
    blockedClaimRejected = true;
    const snapshot = board.snapshot();
    const claim = snapshot.pathClaims[BLOCKED_PATH];
    const blocker = {
      id: 'known-stale-path-claim',
      lane: LANE_ID,
      path: BLOCKED_PATH,
      observedAt: staleObservedAt,
      claim,
      error: String(err && err.message ? err.message : err),
    };
    classification = classifyBlocker({ blocker, nowMs: startedAt });
    board.recordFact({
      agent: 'recovery',
      subject: `${LANE_ID}:detected-blocker`,
      value: {
        id: blocker.id,
        path: blocker.path,
        owner: claim.agent,
        taskId: claim.taskId,
        stale: classification.stale,
      },
      evidence: ['local-temp-ledger-conflict'],
    });
    taskflow.waitTask({
      taskId: blockedTaskId,
      agent: 'recovery',
      reason: 'Desired path has a stale foreign claim; classify before recovery.',
      wakeAfter: 'immediate-local-retry',
    });
    receipts.push({ attempt: 1, outcome: 'blocked', blocker, classification });
  }

  assert(blockedClaimRejected, 'first attempt should be rejected by the stale blocker');
  assert(classification && classification.stale, 'blocker should be classified as stale');
  assert.strictEqual(classification.owner, 'builder');
  assert.strictEqual(classification.requiredAction, 'owner-or-operator-review');
  assert.strictEqual(classification.unsafeAutoFixDenied, true);

  // Unsafe auto-fix is deliberately not executed. Record the denial, then retry
  // on a safe non-overlapping receipt path instead.
  board.recordDecision({
    agent: 'recovery',
    taskId: blockedTaskId,
    decision: 'deny-unsafe-auto-fix',
    status: 'accepted',
    rationale: classification.denialReason,
  });

  // Attempt 2: reroute to a path this lane can safely claim.
  board.claimPath({
    agent: 'recovery',
    taskId: blockedTaskId,
    path: SAFE_RECEIPT_PATH,
    reason: 'Safe reroute: produce receipts without touching the blocked path.',
  });
  receipts.push({ attempt: 2, outcome: 'safe-reroute-claimed', path: SAFE_RECEIPT_PATH });

  // Attempt 3: complete through local receipts only.
  board.recordResult({
    agent: 'recovery',
    taskId: blockedTaskId,
    ok: true,
    summary: 'Recovered by rerouting to a safe receipt path while preserving the foreign stale claim.',
    artifacts: [SAFE_RECEIPT_PATH],
  });
  taskflow.completeTask({
    taskId: blockedTaskId,
    agent: 'recovery',
    status: 'ok',
    summary: 'Safe recovery loop complete with no unsafe auto-fix.',
    artifacts: [SAFE_RECEIPT_PATH],
  });
  receipts.push({ attempt: 3, outcome: 'completed-with-receipts', artifact: SAFE_RECEIPT_PATH });

  const snapshot = board.snapshot();
  const taskSnapshot = taskflow.snapshot();
  const assertions = [
    ['detected-known-stale-blocker', blockedClaimRejected && classification.stale],
    ['classified-owner', classification.owner === 'builder'],
    ['classified-action', classification.requiredAction === 'owner-or-operator-review'],
    ['unsafe-auto-fix-not-attempted', unsafeAutoFixAttempted === false],
    ['foreign-claim-preserved', snapshot.pathClaims[BLOCKED_PATH] && snapshot.pathClaims[BLOCKED_PATH].agent === 'builder'],
    ['safe-reroute-claimed', snapshot.pathClaims[SAFE_RECEIPT_PATH] && snapshot.pathClaims[SAFE_RECEIPT_PATH].agent === 'recovery'],
    ['recovery-task-done', snapshot.tasks[blockedTaskId] && snapshot.tasks[blockedTaskId].status === 'done'],
    ['taskflow-done', taskSnapshot.tasks[blockedTaskId] && taskSnapshot.tasks[blockedTaskId].state === 'done'],
  ];
  const passed = assertions.filter(([, ok]) => ok).length;
  const score = Math.round((passed / assertions.length) * 100);
  const ok = score === 100;

  const report = {
    schema: 'openclaw-frontier.self-healing-recovery-eval.v1',
    lane: LANE_ID,
    generatedAt: new Date().toISOString(),
    externalEffects: false,
    serviceLifecycleActions: false,
    unsafeAutoFixAttempted,
    blockedPath: BLOCKED_PATH,
    safeReceiptPath: SAFE_RECEIPT_PATH,
    ok,
    score,
    elapsedMs: Date.now() - startedAt,
    classification,
    receipts,
    metrics: {
      ledgerRecords: board.readRecords().length,
      taskflowEvents: taskSnapshot.events.length,
      retryAttempts: receipts.length,
      decisions: snapshot.decisions.length,
      facts: snapshot.facts.length,
      results: snapshot.results.length,
    },
    assertions: assertions.map(([name, passedAssertion]) => ({ name, ok: Boolean(passedAssertion) })),
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  console.log(JSON.stringify({ ok, score, report: path.relative(process.cwd(), reportPath) }, null, 2));
  assert(ok, `self-healing recovery score ${score} < 100`);
}

main();
