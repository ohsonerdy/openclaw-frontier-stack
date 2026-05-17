'use strict';

const crypto = require('crypto');

const SCHEMA = 'openclaw-frontier.remote-approval.v1';
const DECISIONS = new Set(['approve', 'request_changes', 'reject']);
const REDACTED = '[REDACTED]';
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-(?!demo-)[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const PRIVATE_PATH_PATTERNS = [
  /\b[A-Za-z]:\\Users\\[^\s\\/]+/g,
  /\/Users\/[^\s\/]+/g,
  /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
];

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sanitizeText(input) {
  let text = String(input == null ? '' : input);
  for (const pattern of [...SECRET_PATTERNS, ...PRIVATE_PATH_PATTERNS]) text = text.replace(pattern, REDACTED);
  return text;
}

function sanitize(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = sanitize(inner);
    return out;
  }
  return value;
}

function assertNoPrivateContent(value) {
  const text = stableStringify(value);
  for (const pattern of [...SECRET_PATTERNS, ...PRIVATE_PATH_PATTERNS]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error('remote approval payload contains unsanitized private content');
  }
}

function createStateSnapshot({ tasks = [], claims = [], receipts = [], tests = [], generatedAt = '2026-01-01T00:00:00.000Z' } = {}) {
  const snapshot = sanitize({ schema: SCHEMA + '.state-snapshot', generatedAt, readOnly: true, tasks, claims, receipts, tests });
  snapshot.snapshotHash = hash(snapshot);
  assertNoPrivateContent(snapshot);
  return snapshot;
}

function createDiffReceipt({ files = [], summary, testCommand, testStatus, generatedAt = '2026-01-01T00:00:00.000Z' }) {
  const receipt = sanitize({
    schema: SCHEMA + '.diff-test-receipt',
    generatedAt,
    summary,
    files: files.map((file) => ({ path: file.path, change: file.change || 'modified', additions: file.additions || 0, deletions: file.deletions || 0 })),
    tests: { command: testCommand, status: testStatus },
  });
  receipt.receiptHash = hash(receipt);
  assertNoPrivateContent(receipt);
  return receipt;
}

function createApprovalRequest({ id, requester, reviewer, action, risk = 'low', stateSnapshot, diffReceipt, expiresAt }) {
  if (!id || !requester || !reviewer || !action) throw new Error('approval request requires id, requester, reviewer, and action');
  const request = sanitize({
    schema: SCHEMA + '.approval-request',
    id,
    requester,
    reviewer,
    action,
    risk,
    mode: 'read-only-parity-demo',
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: expiresAt || null,
    stateSnapshotHash: stateSnapshot && stateSnapshot.snapshotHash,
    diffReceiptHash: diffReceipt && diffReceipt.receiptHash,
    links: {
      stateSnapshot: 'inline://state-snapshot',
      diffReceipt: 'inline://diff-test-receipt',
    },
  });
  request.requestHash = hash(request);
  assertNoPrivateContent(request);
  return request;
}

function decide({ request, reviewer, decision, rationale, conditions = [] }) {
  if (!request || !request.requestHash) throw new Error('decision requires an approval request with requestHash');
  if (!DECISIONS.has(decision)) throw new Error('decision must be approve, request_changes, or reject');
  if (reviewer !== request.reviewer) throw new Error('decision reviewer must match request reviewer');
  const record = sanitize({
    schema: SCHEMA + '.reviewer-decision',
    requestId: request.id,
    requestHash: request.requestHash,
    reviewer,
    decision,
    decidedAt: '2026-01-01T00:05:00.000Z',
    rationale,
    conditions,
    externalEffects: false,
  });
  record.decisionHash = hash(record);
  assertNoPrivateContent(record);
  return record;
}

function buildApprovalPacket(input) {
  const stateSnapshot = createStateSnapshot(input.state || {});
  const diffReceipt = createDiffReceipt(input.diff || {});
  const approvalRequest = createApprovalRequest({ ...input.request, stateSnapshot, diffReceipt });
  const reviewerDecision = input.decision ? decide({ request: approvalRequest, ...input.decision }) : null;
  return sanitize({ schema: SCHEMA + '.packet', stateSnapshot, diffReceipt, approvalRequest, reviewerDecision });
}

module.exports = {
  SCHEMA,
  DECISIONS: Array.from(DECISIONS),
  sanitize,
  assertNoPrivateContent,
  createStateSnapshot,
  createDiffReceipt,
  createApprovalRequest,
  decide,
  buildApprovalPacket,
};
