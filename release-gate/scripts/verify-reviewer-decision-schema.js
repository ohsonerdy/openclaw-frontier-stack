#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const releaseGate = path.resolve(__dirname, '..');
const root = path.resolve(releaseGate, '..');
const schemaRel = 'release-gate/reviewer-decision-schema.md';
const templateRel = 'release-gate/reviewer-decision.template.yaml';
const decisionsRel = 'release-gate/reviewer-decisions';
const schemaPath = path.join(root, schemaRel);
const templatePath = path.join(root, templateRel);
const decisionsDir = path.join(root, decisionsRel);
const requiredFields = ['reviewer', 'version', 'decision', 'reviewed_at', 'evidence', 'conditions', 'blockers', 'notes'];
const allowedReviewers = new Set(['Architecture', 'Security', 'Operations', 'Release']);
const allowedDecisions = new Set(['APPROVE_RELEASE_CANDIDATE', 'APPROVE_RELEASE_CANDIDATE', 'BLOCK']);
const requiredSchemaPhrases = [
  'not upload approval by themselves',
  'Reviewer approval never substitutes for license selection or explicit owner upload approval',
  'APPROVE_RELEASE_CANDIDATE',
  'APPROVE_RELEASE_CANDIDATE',
  'BLOCK',
];
const deniedPatterns = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['tailscale-ip', /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
];

function getYamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}
function scanDenied(text, file, findings) {
  for (const [id, regex] of deniedPatterns) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', pattern: id, file });
  }
}

const findings = [];
if (!fs.existsSync(schemaPath)) {
  findings.push({ issue: 'missing-schema-doc', path: schemaRel });
} else {
  const text = fs.readFileSync(schemaPath, 'utf8');
  for (const phrase of requiredSchemaPhrases) {
    if (!text.includes(phrase)) findings.push({ issue: 'missing-schema-phrase', phrase });
  }
  scanDenied(text, schemaRel, findings);
}
if (!fs.existsSync(templatePath)) {
  findings.push({ issue: 'missing-template', path: templateRel });
} else {
  const text = fs.readFileSync(templatePath, 'utf8');
  for (const field of requiredFields) {
    if (!new RegExp(`^${field}:`, 'm').test(text)) findings.push({ issue: 'template-missing-field', field });
  }
  scanDenied(text, templateRel, findings);
}

if (fs.existsSync(decisionsDir)) {
  for (const name of fs.readdirSync(decisionsDir).filter((entry) => entry.endsWith('.yaml'))) {
    const rel = `${decisionsRel}/${name}`;
    const text = fs.readFileSync(path.join(decisionsDir, name), 'utf8');
    for (const field of requiredFields) {
      if (!new RegExp(`^${field}:`, 'm').test(text)) findings.push({ issue: 'decision-missing-field', file: rel, field });
    }
    const reviewer = getYamlScalar(text, 'reviewer');
    const decision = getYamlScalar(text, 'decision');
    if (!allowedReviewers.has(reviewer)) findings.push({ issue: 'decision-invalid-reviewer', file: rel, reviewer });
    if (!allowedDecisions.has(decision)) findings.push({ issue: 'decision-invalid-decision', file: rel, decision });
    scanDenied(text, rel, findings);
  }
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.reviewer-decision-schema-verification.v1',
  ok,
  requiredFields,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
