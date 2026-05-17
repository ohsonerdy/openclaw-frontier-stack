#!/usr/bin/env node
'use strict';

/*
 * Frontier orchestration scale eval.
 *
 * Local-only, deterministic-enough stress gate for the public package
 * primitives. This does not touch live OpenClaw, NATS, PM2, Telegram, fleet.db,
 * or any external service. It validates the minimum invariants needed before
 * claiming "1000-agent local swarm ready":
 *
 * - 1000 distinct agent identities can be represented.
 * - Each agent can receive a signed TASK and return a signed RESULT.
 * - Each task is claimed, path-claimed, and completed in the blackboard ledger.
 * - Path conflicts are rejected.
 * - Unsafe path labels are rejected.
 * - Signed envelopes verify, tampering fails, and duplicate delivery is idempotent.
 * - A machine-readable report is written for release-gate evidence.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BlackboardLedger,
  BlackboardValidationError,
} = require('../src/blackboard/lib/ledger');
const envelope = require('../src/signed-bus/lib/envelope');
const { TaskFlowRuntime } = require('../src/taskflow/lib/taskflow');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'release-gate', 'reports');
const reportPath = path.join(reportDir, 'latest-frontier-orchestration-scale-eval.json');

const AGENT_COUNT = Number.parseInt(process.env.OPENCLAW_FRONTIER_SCALE_AGENTS || '1000', 10);
const MIN_AGENT_COUNT = 1000;
const MAX_REASONABLE_MS = Number.parseInt(process.env.OPENCLAW_FRONTIER_SCALE_MAX_MS || '120000', 10);

function publicKeyOpenSsh(publicKey, comment) {
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const algo = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.alloc(4), algo,
    Buffer.alloc(4), raw,
  ]);
  blob.writeUInt32BE(algo.length, 0);
  blob.writeUInt32BE(raw.length, 4 + algo.length);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function makeKeypair(keysDir, agent) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPath = path.join(keysDir, `${agent}.pem`);
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, `${agent}.pub`), publicKeyOpenSsh(publicKey, agent) + '\n');
  return { privPath };
}

function assertThrowsValidation(fn, label) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert(
      err instanceof BlackboardValidationError || /already claimed/.test(String(err && err.message)),
      `${label} should throw a blackboard validation/conflict error, got ${err && err.stack ? err.stack : err}`,
    );
  }
  assert(threw, `${label} should have thrown`);
}

function main() {
  const startedAt = Date.now();
  assert(
    Number.isInteger(AGENT_COUNT) && AGENT_COUNT >= MIN_AGENT_COUNT,
    `OPENCLAW_FRONTIER_SCALE_AGENTS must be >= ${MIN_AGENT_COUNT}`,
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-frontier-scale-'));
  const keysDir = path.join(tmp, 'keys');
  const ledgerPath = path.join(tmp, 'blackboard.jsonl');
  fs.mkdirSync(keysDir, { recursive: true });

  const keys = new Map();
  for (const fixedAgent of ['neo', 'sentinel']) {
    keys.set(fixedAgent, makeKeypair(keysDir, fixedAgent));
  }

  const board = new BlackboardLedger({ ledgerPath });
  const taskflow = new TaskFlowRuntime();
  const received = new Set();
  const signedEnvelopes = [];
  let duplicateDrops = 0;

  function sendSigned({ from, to, type, subject, body, lineage = [] }) {
    const env = envelope.createEnvelope({ from, to, type, subject, body, lineage });
    envelope.sign(env, keys.get(from).privPath);
    const verified = envelope.verify(env, { keysDir });
    assert.deepStrictEqual(verified, { valid: true, reason: 'ok' });
    signedEnvelopes.push(env);
    return env;
  }

  function receive(env) {
    const verified = envelope.verify(env, { keysDir });
    assert.strictEqual(verified.valid, true, `envelope ${env.id} should verify`);
    if (received.has(env.id)) {
      duplicateDrops += 1;
      return false;
    }
    received.add(env.id);
    return true;
  }

  for (let i = 0; i < AGENT_COUNT; i += 1) {
    const suffix = String(i).padStart(4, '0');
    const agent = `agent${suffix}`;
    const taskId = `task-${suffix}`;
    const claimPath = `src/shards/shard-${suffix}.js`;
    keys.set(agent, makeKeypair(keysDir, agent));

    const task = sendSigned({
      from: 'neo',
      to: agent,
      type: 'TASK',
      subject: `swarm-task:${taskId}`,
      body: {
        task_id: taskId,
        contract: 'claim task, claim path, return result',
        artifact_path: `out/shards/result-${suffix}.json`,
      },
    });
    receive(task);

    const heartbeat = sendSigned({
      from: agent,
      to: '*',
      type: 'HEARTBEAT',
      subject: `heartbeat:${agent}`,
      body: { status: 'active', task_id: taskId },
    });
    receive(heartbeat);

    board.claimTask({
      agent,
      taskId,
      summary: `Synthetic local scale task ${suffix}`,
    });
    taskflow.createTask({
      taskId,
      title: `Synthetic local scale task ${suffix}`,
      owner: 'neo',
      inputs: { shard: suffix },
    });
    taskflow.claimTask({ taskId, agent });
    board.claimPath({
      agent,
      taskId,
      path: claimPath,
      reason: 'Synthetic unique shard path for scale eval.',
    });

    const result = sendSigned({
      from: agent,
      to: 'neo',
      type: 'RESULT',
      subject: `swarm-result:${taskId}`,
      body: {
        task_id: taskId,
        ok: true,
        artifact: `out/shards/result-${suffix}.json`,
      },
      lineage: [task.id],
    });
    receive(result);

    board.recordResult({
      agent,
      taskId,
      ok: true,
      summary: `Synthetic result ${suffix}`,
      artifacts: [`out/shards/result-${suffix}.json`],
    });
    taskflow.completeTask({
      agent,
      taskId,
      status: 'ok',
      summary: `Synthetic result ${suffix}`,
      artifacts: [`out/shards/result-${suffix}.json`],
    });
  }

  const decision = sendSigned({
    from: 'sentinel',
    to: 'neo',
    type: 'DECISION',
    subject: 'frontier-scale-eval',
    body: {
      decision: 'PASS_LOCAL_SCALE_EVAL',
      agent_count: AGENT_COUNT,
      scope: 'synthetic-local-only',
    },
  });
  receive(decision);
  board.recordDecision({
    agent: 'sentinel',
    taskId: 'task-0000',
    decision: 'PASS_LOCAL_SCALE_EVAL',
    status: 'accepted',
    rationale: 'Synthetic 1000-agent local eval passed package invariants.',
  });

  assertThrowsValidation(
    () => board.claimPath({
      agent: 'agent0999',
      taskId: 'task-conflict',
      path: 'src/shards/shard-0000.js',
      reason: 'Expected conflict probe.',
    }),
    'path conflict probe',
  );

  assertThrowsValidation(
    () => board.claimPath({
      agent: 'agent0001',
      taskId: 'task-secret-path',
      path: 'secrets/token-report.txt',
      reason: 'Expected unsafe path probe.',
    }),
    'unsafe path probe',
  );

  const tampered = {
    ...signedEnvelopes[0],
    body: { ...signedEnvelopes[0].body, contract: 'tampered' },
  };
  assert.strictEqual(envelope.verify(tampered, { keysDir }).valid, false, 'tampered envelope must fail verify');

  assert.strictEqual(receive(signedEnvelopes[0]), false, 'duplicate envelope should be ignored by receiver');

  const snapshot = board.snapshot();
  const taskflowSnapshot = taskflow.snapshot();
  const taskIds = Object.keys(snapshot.tasks);
  const taskflowTaskIds = Object.keys(taskflowSnapshot.tasks);
  const pathClaims = Object.keys(snapshot.pathClaims);
  const doneTasks = taskIds.filter((taskId) => snapshot.tasks[taskId].status === 'done');
  const taskflowDoneTasks = taskflowTaskIds.filter((taskId) => taskflowSnapshot.tasks[taskId].state === 'done');
  const elapsedMs = Date.now() - startedAt;

  const assertions = [
    ['agent-count', AGENT_COUNT >= MIN_AGENT_COUNT],
    ['task-count', taskIds.length === AGENT_COUNT],
    ['done-task-count', doneTasks.length === AGENT_COUNT],
    ['path-claim-count', pathClaims.length === AGENT_COUNT],
    ['result-count', snapshot.results.length === AGENT_COUNT],
    ['taskflow-task-count', taskflowTaskIds.length === AGENT_COUNT],
    ['taskflow-done-count', taskflowDoneTasks.length === AGENT_COUNT],
    ['decision-count', snapshot.decisions.length === 1],
    ['envelope-count', signedEnvelopes.length === (AGENT_COUNT * 3) + 1],
    ['receive-idempotency', received.size === signedEnvelopes.length && duplicateDrops === 1],
    ['tamper-rejected', envelope.verify(tampered, { keysDir }).valid === false],
    ['unsafe-path-rejected', true],
    ['runtime-budget', elapsedMs <= MAX_REASONABLE_MS],
    ['closed-envelope-type-set', JSON.stringify(envelope.VALID_TYPES) === JSON.stringify([
      'TASK', 'RESULT', 'FACT', 'OBSERVATION', 'DECISION', 'ALERT', 'BANTER', 'HEARTBEAT',
    ])],
  ];

  const passed = assertions.filter(([, ok]) => ok).length;
  const score = Math.round((passed / assertions.length) * 100);
  const ok = score >= 99;

  const report = {
    schema: 'openclaw-frontier.scale-eval.v1',
    generatedAt: new Date().toISOString(),
    externalEffects: false,
    agentCount: AGENT_COUNT,
    score,
    ok,
    elapsedMs,
    metrics: {
      taskCount: taskIds.length,
      doneTaskCount: doneTasks.length,
      pathClaimCount: pathClaims.length,
      resultCount: snapshot.results.length,
      decisionCount: snapshot.decisions.length,
      taskflowTaskCount: taskflowTaskIds.length,
      taskflowDoneTaskCount: taskflowDoneTasks.length,
      taskflowEventKinds: taskflowSnapshot.counts,
      signedEnvelopeCount: signedEnvelopes.length,
      uniqueReceivedEnvelopeCount: received.size,
      duplicateDrops,
      ledgerRecordKinds: snapshot.counts,
    },
    assertions: assertions.map(([name, passedAssertion]) => ({ name, ok: Boolean(passedAssertion) })),
    notes: [
      'Synthetic local-only eval. No live fleet.db, NATS, PM2, Telegram, GitHub, or network access.',
      'This proves package primitive scale, not production daemon uptime.',
      'True multi-process write contention still requires a separate live-system SQLite/NATS soak test.',
    ],
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok,
    score,
    agents: AGENT_COUNT,
    elapsedMs,
    signedEnvelopes: signedEnvelopes.length,
    duplicateDrops,
    report: path.relative(process.cwd(), reportPath).replace(/\\/g, '/'),
  }, null, 2));

  process.exit(ok ? 0 : 1);
}

main();
