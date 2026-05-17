#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const docRel = 'docs/communication-planes.md';
const cfgRel = 'templates/config/communication-planes.example.json';
const findings = [];
const denied = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['ipv4-address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['forbidden-domain', /\b(?:finance|financial|trading|portfolio|alpaca|quiltt)\b/i],
];
function text(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    findings.push({ issue: 'missing-file', path: rel });
    return '';
  }
  const body = fs.readFileSync(full, 'utf8');
  for (const [id, regex] of denied) {
    if (regex.test(body)) findings.push({ issue: 'denied-pattern', path: rel, pattern: id });
  }
  return body;
}
const doc = text(docRel);
for (const phrase of ['Telegram', 'Discord', 'Slack', 'Standard channel layout', 'Install sequence', 'mention-gating', 'templates/config/communication-planes.example.json']) {
  if (!doc.includes(phrase)) findings.push({ issue: 'missing-doc-phrase', phrase });
}
const cfgText = text(cfgRel);
if (cfgText) {
  try {
    const cfg = JSON.parse(cfgText);
    if (cfg.schema !== 'openclaw-frontier.communication-planes.v1') findings.push({ issue: 'bad-schema' });
    for (const provider of ['telegram', 'discord', 'slack']) {
      if (!cfg.providers || !cfg.providers[provider]) findings.push({ issue: 'missing-provider', provider });
    }
    if (!cfg.human_message_policy?.summarize_alerts) findings.push({ issue: 'missing-summarize-alerts-policy' });
    if (!cfg.human_message_policy?.never_echo_raw_bus_json) findings.push({ issue: 'missing-raw-json-policy' });
    const approvals = cfg.human_message_policy?.approval_required_for || [];
    for (const required of ['destructive-change', 'external-publish', 'credential-handling', 'privacy-sensitive-action', 'security-policy-change']) {
      if (!approvals.includes(required)) findings.push({ issue: 'missing-approval-class', required });
    }
  } catch (err) {
    findings.push({ issue: 'invalid-json', error: err.message });
  }
}
const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.communication-planes-verification.v1',
  ok,
  files: [docRel, cfgRel],
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
