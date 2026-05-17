#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const rel = 'docs/WIKI_INDEX.md';
const full = path.join(root, rel);
const findings = [];
const requiredHeadings = [
  '# OpenClaw Frontier Stack wiki index',
  '## Start here',
  '## Architecture',
  '## Runtime subsystems',
  '## Demos and examples',
  '## Release gate',
  '## Upload blockers',
  '## Maintenance rule',
];
const requiredLinks = [
  '../README.md',
  'public-release-boundaries.md',
  'agent-roster-manifest.md',
  'delegation-router-policy.md',
  'mission-control-control-plane.md',
  '../release-gate/checklist.md',
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

if (!fs.existsSync(full)) {
  findings.push({ issue: 'missing-wiki-index', path: rel });
} else {
  const text = fs.readFileSync(full, 'utf8');
  for (const heading of requiredHeadings) {
    if (!text.includes(heading)) findings.push({ issue: 'missing-heading', heading });
  }
  for (const link of requiredLinks) {
    if (!text.includes(`](${link})`)) findings.push({ issue: 'missing-link', link });
  }
  for (const [id, regex] of denied) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', pattern: id });
  }
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]).filter((href) => !href.startsWith('http'));
  for (const href of links) {
    const target = path.resolve(path.dirname(full), href.split('#')[0]);
    if (!fs.existsSync(target)) findings.push({ issue: 'broken-link', href });
  }
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.wiki-index-verification.v1',
  ok,
  file: rel,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
