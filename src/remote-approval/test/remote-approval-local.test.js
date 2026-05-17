'use strict';

const assert = require('assert');
const approval = require('../lib/remote-approval');

const unsafeHomePathFixture = ['', 'Users', 'fixture-user', 'project', 'output.log'].join('/');
const unsafeGithubTokenFixture = ['ghp', 'fixturetokenplaceholder1234'].join('_');

const packet = approval.buildApprovalPacket({
  state: {
    tasks: [{ id: 'task-demo-1', status: 'review', owner: 'builder', title: 'Publish candidate dry run' }],
    claims: [{ path: 'src/demo-app.js', owner: 'builder', mode: 'read-only-review' }],
    receipts: [{ id: 'receipt-1', artifact: unsafeHomePathFixture, token: unsafeGithubTokenFixture }],
    tests: [{ command: 'npm run verify', status: 'PASS' }],
  },
  diff: {
    summary: 'Read-only approval packet for sanitized release candidate.',
    files: [{ path: 'src/demo-app.js', change: 'modified', additions: 12, deletions: 2 }],
    testCommand: 'npm run verify',
    testStatus: 'PASS',
  },
  request: {
    id: 'approval-demo-1',
    requester: 'orchestrator',
    reviewer: 'sentinel',
    action: 'Approve sanitized package upload after operator confirmation.',
    risk: 'medium',
  },
  decision: {
    reviewer: 'sentinel',
    decision: 'request_changes',
    rationale: 'Require explicit operator upload approval before any external effect.',
    conditions: ['No publish from demo flow', 'Attach verifier receipt'],
  },
});

assert.strictEqual(packet.schema, approval.SCHEMA + '.packet');
assert.strictEqual(packet.stateSnapshot.readOnly, true);
assert.match(packet.stateSnapshot.snapshotHash, /^[a-f0-9]{64}$/);
assert.match(packet.diffReceipt.receiptHash, /^[a-f0-9]{64}$/);
assert.strictEqual(packet.approvalRequest.stateSnapshotHash, packet.stateSnapshot.snapshotHash);
assert.strictEqual(packet.approvalRequest.diffReceiptHash, packet.diffReceipt.receiptHash);
assert.strictEqual(packet.reviewerDecision.requestHash, packet.approvalRequest.requestHash);
assert.strictEqual(packet.reviewerDecision.externalEffects, false);
assert.doesNotThrow(() => approval.assertNoPrivateContent(packet));
assert(!JSON.stringify(packet).includes(unsafeGithubTokenFixture), 'token must be redacted');
assert(!JSON.stringify(packet).includes(unsafeHomePathFixture), 'private path must be redacted');
assert.throws(() => approval.decide({ request: packet.approvalRequest, reviewer: 'architect', decision: 'approve', rationale: 'wrong reviewer' }), /reviewer/);
assert.throws(() => approval.decide({ request: packet.approvalRequest, reviewer: 'sentinel', decision: 'ship_it', rationale: 'invalid' }), /decision/);

console.log(JSON.stringify({ ok: true, schema: packet.schema, hashesLinked: true, privateContentRejected: true, externalEffects: false }, null, 2));
