#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'release-gate', 'reports');
fs.mkdirSync(reportDir, { recursive: true });

const laneId = 'FR-SECURITY-GOV-001';
const artifacts = [
  'docs/security-governance.md',
];

const requiredPhrases = [
  'FR-SECURITY-GOV-001',
  'SecretRef: FRONTIER_SIGNING_KEY',
  'No-public-secrets guard',
  'two-agent/two-hardware',
  'Approval gates',
  'Incident deductions',
  'explicit operator approval',
  'must not include live credentials',
];

const deniedPatterns = [
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['openai-or-generic-secret-key', /\bsk-(?!example|placeholder)[A-Za-z0-9_-]{20,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/],
  ['telegram-bot-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['slack-token', /\bxox[abpors]-[A-Za-z0-9-]{20,}\b/],
  ['private-home-path', /(?:\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/],
  ['tailscale-ip', /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['rfc1918-ip', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/],
];

function lineFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanArtifact(rel) {
  const full = path.join(root, rel);
  const findings = [];
  if (!fs.existsSync(full)) {
    findings.push({ issue: 'missing-artifact', path: rel });
    return findings;
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const [id, regex] of deniedPatterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text))) {
      findings.push({ issue: 'denied-pattern', pattern: id, path: rel, line: lineFor(text, match.index) });
      if (!regex.global) break;
    }
  }
  return findings;
}

function verifyRequiredPhrases() {
  const combined = artifacts
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .map((rel) => fs.readFileSync(path.join(root, rel), 'utf8'))
    .join('\n');
  return requiredPhrases
    .filter((phrase) => !combined.includes(phrase))
    .map((phrase) => ({ issue: 'missing-required-phrase', phrase }));
}

function evaluateQuorum(approvals, options = {}) {
  const deniedRoles = new Set(options.deniedRoles || []);
  const valid = approvals.filter((approval) =>
    approval &&
    approval.decision === 'approve' &&
    approval.agentId &&
    approval.hardwareId &&
    approval.reason &&
    !deniedRoles.has(approval.role)
  );
  const agents = new Set(valid.map((approval) => approval.agentId));
  const hardware = new Set(valid.map((approval) => approval.hardwareId));
  return {
    ok: agents.size >= 2 && hardware.size >= 2,
    approvingAgents: agents.size,
    approvingHardware: hardware.size,
  };
}

function evaluateApprovalGates(gates) {
  const required = [
    'secretHygiene',
    'quorum',
    'reviewerRecord',
    'licenseSelected',
    'operatorApproval',
    'incidentPosture',
  ];
  const missing = required.filter((gate) => gates[gate] !== true);
  return { ok: missing.length === 0, missing };
}

function scoreIncidents(incidents) {
  let score = 100;
  let blocked = false;
  const deductions = [];
  for (const incident of incidents) {
    if (incident.severity === 'critical' && incident.status !== 'resolved') {
      blocked = true;
      deductions.push({ id: incident.id, points: 100, reason: 'open-critical-incident-blocks-release' });
      continue;
    }
    const points = incident.severity === 'high' ? 20 : incident.severity === 'medium' ? 10 : incident.severity === 'low' ? 5 : 0;
    if (points) {
      score -= points;
      deductions.push({ id: incident.id, points, reason: `${incident.severity}-severity-incident` });
    }
    if (!incident.reviewedAt) {
      score -= 5;
      deductions.push({ id: incident.id, points: 5, reason: 'missing-review-timestamp' });
    }
  }
  return { ok: !blocked && score >= 80, blocked, score: Math.max(0, score), deductions };
}

const findings = [
  ...verifyRequiredPhrases(),
  ...artifacts.flatMap(scanArtifact),
];

const quorum = evaluateQuorum([
  { agentId: 'sentinel-reviewer', role: 'sentinel', hardwareId: 'host-a', decision: 'approve', reason: 'candidate secret hygiene passed' },
  { agentId: 'release-reviewer', role: 'release', hardwareId: 'host-b', decision: 'approve', reason: 'candidate gate packet reviewed' },
]);
if (!quorum.ok) findings.push({ issue: 'synthetic-quorum-failed', quorum });

const incidentScore = scoreIncidents([
  { id: 'synthetic-low-doc-finding', severity: 'low', status: 'resolved', reviewedAt: '2026-01-01T00:00:00.000Z' },
]);
if (!incidentScore.ok) findings.push({ issue: 'synthetic-incident-posture-failed', incidentScore });

const approvalGates = evaluateApprovalGates({
  secretHygiene: findings.filter((finding) => finding.issue === 'denied-pattern').length === 0,
  quorum: quorum.ok,
  reviewerRecord: true,
  licenseSelected: fs.existsSync(path.join(root, 'LICENSE')),
  operatorApproval: true,
  incidentPosture: incidentScore.ok,
});
if (!approvalGates.ok) findings.push({ issue: 'synthetic-approval-gates-failed', missing: approvalGates.missing });

const report = {
  schema: 'openclaw-frontier.security-governance-eval.v1',
  ok: findings.length === 0,
  laneId,
  generatedAt: new Date().toISOString(),
  externalEffects: false,
  artifacts,
  checks: {
    requiredPhrases: requiredPhrases.length,
    deniedPatterns: deniedPatterns.map(([id]) => id),
    quorum,
    approvalGates,
    incidentScore,
  },
  findings,
};

const reportPath = path.join(reportDir, 'latest-security-governance-eval.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({
  ok: report.ok,
  laneId,
  externalEffects: false,
  findings: findings.length,
  report: path.relative(process.cwd(), reportPath).replace(/\\/g, '/'),
}, null, 2));

process.exit(report.ok ? 0 : 1);
