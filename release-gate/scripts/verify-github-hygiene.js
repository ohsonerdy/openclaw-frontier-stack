#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const requiredFiles = [
  'docs/github-repository-hygiene.md',
  'templates/github/CONTRIBUTING.md',
  'templates/github/SECURITY.md',
  'templates/github/CODE_OF_CONDUCT.md',
  'templates/github/pull_request_template.md',
  'templates/github/ISSUE_TEMPLATE/bug_report.md',
  'templates/github/ISSUE_TEMPLATE/architecture_proposal.md',
];

const requiredPhrases = new Map([
  ['docs/github-repository-hygiene.md', ['human upload approval', 'readyForGithubUpload', 'Do not copy private repository settings']],
  ['templates/github/CONTRIBUTING.md', ['node scripts/verify-package.js', 'Keep examples synthetic', 'Do not include credentials']],
  ['templates/github/SECURITY.md', ['Never open an issue or pull request containing live credentials', 'rotate it outside this repository']],
  ['templates/github/pull_request_template.md', ['No credentials', 'Examples are synthetic and local-only', 'clean-export scope']],
  ['templates/github/ISSUE_TEMPLATE/bug_report.md', ['Do not include credentials', 'private hostnames/IPs']],
]);

const deniedPatterns = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['tailscale-ip', /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
];

const findings = [];
for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    findings.push({ file: rel, issue: 'missing-required-file' });
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  if (!text.trim()) findings.push({ file: rel, issue: 'empty-file' });
  for (const phrase of requiredPhrases.get(rel) || []) {
    if (!text.includes(phrase)) findings.push({ file: rel, issue: 'missing-required-phrase', phrase });
  }
  for (const [id, regex] of deniedPatterns) {
    if (regex.test(text)) findings.push({ file: rel, issue: 'denied-pattern', pattern: id });
  }
}

const ok = findings.length === 0;
const result = {
  schema: 'openclaw-frontier.github-hygiene-verification.v1',
  ok,
  checkedFiles: requiredFiles.length,
  findings,
};
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
