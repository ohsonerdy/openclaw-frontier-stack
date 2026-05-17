#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const rel = 'docs/public-release-boundaries.md';
const full = path.join(root, rel);

const required = [
  'Allowed content',
  'Excluded content',
  'Placeholder policy',
  'Pre-upload operator checks',
  'explicit operator approval',
  'record private operational evidence outside the package',
];
const denied = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['ipv4-address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const operatorDenyTerms = (process.env.OPENCLAW_FRONTIER_DENY_TERMS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

operatorDenyTerms.forEach((term, index) => {
  denied.push([
    `operator-deny-term-${index + 1}`,
    new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'),
  ]);
});

const findings = [];
if (!fs.existsSync(full)) {
  findings.push({ issue: 'missing-public-release-boundaries', path: rel });
} else {
  const text = fs.readFileSync(full, 'utf8');
  for (const phrase of required) {
    if (!text.includes(phrase)) findings.push({ issue: 'missing-required-phrase', phrase });
  }
  for (const [id, regex] of denied) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', pattern: id });
  }
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.public-release-boundaries-verification.v1',
  ok,
  file: rel,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
