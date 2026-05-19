#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { voting } = require('../voting.js');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-vote-'));
  const ledger = createLedger({ ledgerPath: path.join(tmp, 'blackboard.jsonl') });

  // 3-of-4 approve, threshold = 2/3 → verdict: approve
  const result = await voting({
    goalId: 'goal-ship-vote',
    decision: 'Ship release v0.6.0?',
    voters: [
      { id: 'sec', role: 'sentinel' },
      { id: 'rev', role: 'reviewer' },
      { id: 'arch', role: 'architect' },
      { id: 'build', role: 'builder' },
    ],
    ledger,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    quorum: 3,
    threshold: 2 / 3,
    mockVotes: [
      { voterId: 'sec', ok: true, summary: 'security clean' },
      { voterId: 'rev', ok: true, summary: 'reviewed' },
      { voterId: 'arch', ok: true, summary: 'architecture sound' },
      { voterId: 'build', ok: false, summary: 'concerns about build' },
    ],
  });

  assert.strictEqual(result.pattern, 'voting');
  assert.strictEqual(result.decided, true);
  assert.strictEqual(result.verdict, 'approve');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tally.approve, 3);
  assert.strictEqual(result.tally.reject, 1);
  assert.strictEqual(result.quorumMet, true);
  assert.strictEqual(result.thresholdMet, true);
  assert.strictEqual(result.votes.length, 4);

  // 1-of-3 approve, threshold = 2/3 → verdict: reject
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-vote-rej-'));
  const ledger2 = createLedger({ ledgerPath: path.join(tmp2, 'blackboard.jsonl') });
  const result2 = await voting({
    goalId: 'goal-risky-vote',
    decision: 'Bypass safety check?',
    voters: [
      { id: 's1', role: 'sentinel' },
      { id: 's2', role: 'sentinel' },
      { id: 's3', role: 'sentinel' },
    ],
    ledger: ledger2,
    timeoutMs: 5000,
    pollIntervalMs: 50,
    threshold: 2 / 3,
    mockVotes: [
      { voterId: 's1', ok: true, summary: 'fine with me' },
      { voterId: 's2', ok: false, summary: 'not safe' },
      { voterId: 's3', ok: false, summary: 'nope' },
    ],
  });
  assert.strictEqual(result2.verdict, 'reject');
  assert.strictEqual(result2.ok, false);
  assert.strictEqual(result2.tally.approve, 1);
  assert.strictEqual(result2.tally.reject, 2);

  // Quorum-not-met: only 1 voter responds, quorum = 2 → not decided
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-vote-quor-'));
  const ledger3 = createLedger({ ledgerPath: path.join(tmp3, 'blackboard.jsonl') });
  const result3 = await voting({
    goalId: 'g',
    decision: 'unanswered question?',
    voters: [
      { id: 'a', role: 'reviewer' },
      { id: 'b', role: 'reviewer' },
      { id: 'c', role: 'reviewer' },
    ],
    ledger: ledger3,
    quorum: 2,
    threshold: 0.5,
    timeoutMs: 250,
    pollIntervalMs: 50,
    mockVotes: [{ voterId: 'a', ok: true, summary: 'yes' }],
  });
  assert.strictEqual(result3.quorumMet, false);
  assert.strictEqual(result3.decided, false);
  assert.strictEqual(result3.verdict, 'reject');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  fs.rmSync(tmp3, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, name: 'voting.test' }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`voting.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
