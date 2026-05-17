#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const rel = 'docs/delegation-router-policy.md';
const full = path.join(root, rel);
const required = [
  'Safety gate',
  'Ownership match',
  'Capability match',
  'Freshness check',
  'Parallel split',
  'Output contract',
  'approval_required',
  'must not become a hidden authority system',
];
const denied = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['ipv4-address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['forbidden-domain', /\b(?:finance|financial|trading|portfolio|alpaca|quiltt)\b/i],
];
const findings = [];
if (!fs.existsSync(full)) {
  findings.push({ issue: 'missing-delegation-router-policy', path: rel });
} else {
  const text = fs.readFileSync(full, 'utf8');
  for (const phrase of required) {
    if (!text.includes(phrase)) findings.push({ issue: 'missing-required-phrase', phrase });
  }
  for (const [id, regex] of denied) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', pattern: id });
  }
  const match = text.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    findings.push({ issue: 'missing-json-contract' });
  } else {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.schema !== 'openclaw-frontier.delegation-decision.v1') findings.push({ issue: 'bad-contract-schema' });
      for (const key of ['request_id', 'decision', 'selected_agents', 'reason', 'risk_tier', 'approval_required', 'child_tasks', 'blocker']) {
        if (!(key in parsed)) findings.push({ issue: 'missing-contract-key', key });
      }
    } catch (err) {
      findings.push({ issue: 'invalid-json-contract', error: err.message });
    }
  }
}
const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.delegation-router-policy-verification.v1',
  ok,
  file: rel,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
