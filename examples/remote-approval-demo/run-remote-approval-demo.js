#!/usr/bin/env node
'use strict';

// Production-safe read-only remote approval/state parity demo.
// It models the reviewer flow without network calls, credentials, or external writes.

const approval = require('../../src/remote-approval/lib/remote-approval');

const packet = approval.buildApprovalPacket({
  state: {
    generatedAt: '2026-01-01T00:00:00.000Z',
    tasks: [
      { id: 'goal-remote-approval', lane: 'release', status: 'awaiting-review', owner: 'orchestrator' },
      { id: 'verify-remote-approval', lane: 'verification', status: 'passed', owner: 'verifier' },
    ],
    claims: [
      { path: 'docs/remote-approval-state-parity.md', owner: 'docs', mode: 'review' },
      { path: 'src/remote-approval/lib/remote-approval.js', owner: 'builder', mode: 'review' },
    ],
    receipts: [
      { id: 'diff-1', kind: 'diff', summary: 'Schema, demo, and tests added.' },
      { id: 'test-1', kind: 'test', command: 'node src/remote-approval/test/remote-approval-local.test.js', status: 'PASS' },
    ],
    tests: [{ command: 'npm run verify', status: 'pending-in-demo' }],
  },
  diff: {
    generatedAt: '2026-01-01T00:01:00.000Z',
    summary: 'Add a read-only remote approval/state parity packet with linked snapshot and test receipt.',
    files: [
      { path: 'src/remote-approval/lib/remote-approval.js', change: 'added', additions: 150, deletions: 0 },
      { path: 'docs/remote-approval-state-parity.md', change: 'added', additions: 80, deletions: 0 },
    ],
    testCommand: 'node src/remote-approval/test/remote-approval-local.test.js',
    testStatus: 'PASS',
  },
  request: {
    id: 'remote-approval-demo-001',
    requester: 'orchestrator',
    reviewer: 'sentinel',
    action: 'Review release candidate state and approve only if operator upload approval is present.',
    risk: 'medium',
  },
  decision: {
    reviewer: 'sentinel',
    decision: 'request_changes',
    rationale: 'Demo proves read-only parity. External upload remains blocked until explicit operator approval.',
    conditions: ['Attach latest verifier receipt', 'Bind decision to final artifact hash'],
  },
});

console.log(JSON.stringify({ ok: true, externalEffects: false, packet }, null, 2));
