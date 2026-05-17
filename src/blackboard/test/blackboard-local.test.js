#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BlackboardLedger,
  BlackboardValidationError,
  normalizeRecordPath,
  parseJsonl,
} = require('../lib/ledger');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-frontier-blackboard-'));
const ledgerPath = path.join(tmp, 'ledger.jsonl');
const board = new BlackboardLedger({ ledgerPath });

board.claimTask({
  agent: 'builder',
  taskId: 'task-001',
  summary: 'Create a synthetic demo artifact.',
});
board.claimPath({
  agent: 'builder',
  taskId: 'task-001',
  path: 'src/demo-app.js',
  reason: 'Synthetic patch target.',
});
board.recordFact({
  agent: 'reviewer',
  subject: 'artifact-scope',
  value: { localOnly: true, externalEffects: false },
  evidence: ['review-notes/demo-artifact.md'],
});
board.recordDecision({
  agent: 'sentinel',
  taskId: 'task-001',
  decision: 'APPROVE_RELEASE_CANDIDATE',
  status: 'accepted',
  rationale: 'Synthetic artifact passes local package checks.',
});
board.recordResult({
  agent: 'builder',
  taskId: 'task-001',
  ok: true,
  summary: 'Synthetic artifact produced.',
  artifacts: ['out/demo-artifact.patch'],
});

let snapshot = board.snapshot();
assert.strictEqual(snapshot.tasks['task-001'].status, 'done');
assert.deepStrictEqual(Object.keys(snapshot.pathClaims), ['src/demo-app.js']);
assert.strictEqual(snapshot.facts.length, 1);
assert.strictEqual(snapshot.decisions.length, 1);
assert.strictEqual(snapshot.results.length, 1);

assert.throws(
  () => board.claimPath({ agent: 'reviewer', taskId: 'task-002', path: 'src/demo-app.js' }),
  /already claimed/
);

board.releasePath({
  agent: 'builder',
  taskId: 'task-001',
  path: 'src/demo-app.js',
  reason: 'Demo work complete.',
});
board.claimPath({
  agent: 'reviewer',
  taskId: 'task-002',
  path: 'src/demo-app.js',
  reason: 'Post-build review.',
});

snapshot = board.snapshot();
assert.strictEqual(snapshot.pathClaims['src/demo-app.js'].agent, 'reviewer');

const rejectedPaths = [
  '/absolute/file.js',
  'C:\\workspace\\file.js',
  '../escape.js',
  'src/../escape.js',
  'config/.env',
  'keys/demo.pem',
  'notes/api-key.txt',
];
for (const candidate of rejectedPaths) {
  assert.throws(
    () => normalizeRecordPath(candidate),
    BlackboardValidationError,
    `expected rejection for ${candidate}`
  );
}

assert.strictEqual(normalizeRecordPath('src\\windows-style.js'), 'src/windows-style.js');
assert.throws(
  () => board.recordResult({
    agent: 'builder',
    taskId: 'task-003',
    ok: true,
    summary: 'Unsafe artifact reference should be rejected.',
    artifacts: ['out/token-report.txt'],
  }),
  BlackboardValidationError
);

const rawLines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/);
const parsed = parseJsonl(fs.readFileSync(ledgerPath, 'utf8'));
assert.strictEqual(rawLines.length, parsed.length);
assert(parsed.every((record) => record.schema === 'openclaw-frontier.blackboard-ledger.v1'));

console.log(JSON.stringify({
  ok: true,
  records: parsed.length,
  activePathClaims: Object.keys(snapshot.pathClaims).length,
  rejectedPaths: rejectedPaths.length,
  kinds: snapshot.counts,
}, null, 2));
