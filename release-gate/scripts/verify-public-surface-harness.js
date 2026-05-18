#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const expectedOwner = 'ohsonerdy';
const expectedEmail = ['179361416+ohsonerdy', 'users.noreply.github.com'].join('@');

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
  });
}

function safeRead(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'out'].includes(entry.name)) continue;
      if (/^release-gate\/(reports|artifacts|exports)\b/.test(rel)) continue;
      out.push(...walk(full));
    } else {
      if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|gz|zip|lock)$/i.test(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

function lineFindings(rel, text, checks) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const check of checks) {
      if (check.skipPath && check.skipPath(rel)) continue;
      const match = line.match(check.regex);
      if (match) {
        const token = match[0];
        const before = line.slice(Math.max(0, match.index - 20), match.index);
        const after = line.slice(match.index + token.length, match.index + token.length + 40);
        if (check.issue === 'demo-language-on-public-surface' && /[\/A-Za-z0-9_-]$/.test(before) && /^[\/A-Za-z0-9_.-]/.test(after)) continue;
        findings.push({ file: rel, line: idx + 1, issue: check.issue, match: token.slice(0, 160), guidance: check.guidance });
      }
    }
  });
  return findings;
}

const findings = [];
const gitDirExists = fs.existsSync(path.join(root, '.git'));
const standaloneExport = process.env.OPENCLAW_FRONTIER_STANDALONE_EXPORT === '1';
let commitRows = [];
if (gitDirExists) {
  try {
    commitRows = git(['log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%s']).trim().split(/\r?\n/).filter(Boolean);
  } catch (err) {
    findings.push({ issue: 'git-log-unreadable', detail: String(err.message || err) });
  }
} else if (!standaloneExport) {
  findings.push({ issue: 'git-metadata-missing', guidance: 'Run in a git checkout, or set OPENCLAW_FRONTIER_STANDALONE_EXPORT=1 for generated tarball/source export verification.' });
}
for (const row of commitRows) {
  const [sha, authorName, authorEmail, committerName, committerEmail] = row.split('\x00');
  const short = (sha || '').slice(0, 12);
  let body = '';
  try { body = git(['log', '-1', '--format=%B', sha]); } catch {}
  for (const [field, value, expected] of [
    ['author.name', authorName, expectedOwner],
    ['author.email', authorEmail, expectedEmail],
    ['committer.name', committerName, expectedOwner],
    ['committer.email', committerEmail, expectedEmail],
  ]) {
    if (value !== expected) findings.push({ commit: short, issue: 'bad-git-attribution', field, value, expected });
  }
  if (/^Co-authored-by:/im.test(body)) findings.push({ commit: short, issue: 'co-author-trailer-forbidden', guidance: 'Public releases must not add agent/bot co-author trailers.' });
}

let currentName = '';
let currentEmail = '';
if (gitDirExists) {
  try { currentName = git(['config', '--get', 'user.name']).trim(); } catch {}
  try { currentEmail = git(['config', '--get', 'user.email']).trim(); } catch {}
  if (currentName && currentName !== expectedOwner) findings.push({ issue: 'bad-local-git-user-name', value: currentName, expected: expectedOwner });
  if (currentEmail && currentEmail !== expectedEmail) findings.push({ issue: 'bad-local-git-user-email', value: currentEmail, expected: expectedEmail });
}

const forbiddenIdentityChecks = [
  { issue: 'forbidden-github-handle', regex: /\b(?:neoclawexe|neoclaw|Yoru_Mac_bot|Neo_Wellington_bot|Rei_construct_bot)\b/i, guidance: 'Do not tag or name agent accounts/handles on the public product surface.' },
  { issue: 'forbidden-agent-attribution', regex: /\b(?:Yoru|Neo|Rei|OpenClaw Release Bot)\b\s*<[^>]*>/i, guidance: 'Public git attribution must be ohsonerdy only.' },
  { issue: 'forbidden-noreply-attribution', regex: /\b(?:yoru|neo|rei|openclaw-release-bot)@users\.noreply\.github\.com\b/i, guidance: 'Public git attribution must be ohsonerdy only.' },
  { issue: 'forbidden-coauthor-line', regex: /^\s*Co-authored-by:/i, guidance: 'No agent/bot co-author trailers on public releases.' },
];

const publicSurfacePath = (rel) => /^(README\.md|STATUS\.md|CHANGELOG\.md|package\.json|docs\/|templates\/|release-gate\/(checklist\.md|release-notes\/|reviewer.*\.md)|\.github\/)/.test(rel);
const terminologyChecks = [
  { issue: 'demo-language-on-public-surface', regex: /\b(?:demo|demonstration)\b/i, guidance: 'Use production/drop-in wording. If a runnable path is illustrative, call it a production smoke test or quickstart flow, not demo.' },
  { issue: 'reference-positioning-on-public-surface', regex: /\b(?:reference implementation|reference package|reference-only|demo-only)\b/i, guidance: 'Do not frame the product as reference/demo-only when release intent is production drop-in ready.' },
  { issue: 'sanitized-residue-on-public-surface', regex: /\b(?:sanitized|clean export|clean-export|scrubbed)\b/i, guidance: 'Do not expose internal sanitization/release-scrub terminology on public product surfaces.' },
  { issue: 'toy-sample-language-on-public-surface', regex: /\b(?:toy|sample)\b/i, guidance: 'Use production fixture, quickstart, or integration template where accurate.' },
  { issue: 'broken-command-name-on-public-surface', regex: /npm run acceptance scenario/i, guidance: 'Use the real package script name: npm run smoke.' },
  { issue: 'broken-example-path-on-public-surface', regex: /(?:`examples\/[^`]*acceptance scenario[^`]*`|node\s+\S*examples\/[^\n]*acceptance scenario)/i, guidance: 'Public docs must reference real example paths.' },
];

for (const rel of walk(root)) {
  const text = safeRead(rel);
  if (!text) continue;
  const isHarness = rel === 'release-gate/scripts/verify-public-surface-harness.js' || rel === 'release-gate/scripts/verify-github-public-readback.js';
  if (!isHarness) findings.push(...lineFindings(rel, text, forbiddenIdentityChecks));
  if (!isHarness && publicSurfacePath(rel)) findings.push(...lineFindings(rel, text, terminologyChecks));
}

const pkg = JSON.parse(safeRead('package.json') || '{}');
if (!/production/i.test(pkg.description || '')) findings.push({ file: 'package.json', issue: 'package-description-missing-production-positioning' });
if (!/(drop-in|drop in|production-ready|production ready)/i.test(`${pkg.description || ''} ${(pkg.keywords || []).join(' ')}`)) findings.push({ file: 'package.json', issue: 'package-metadata-missing-drop-in-ready-positioning' });

const report = {
  schema: 'openclaw-frontier.public-surface-harness.v1',
  ok: findings.length === 0,
  expectedContributor: { login: expectedOwner, email: expectedEmail },
  checkedCommits: commitRows.length,
  gitMetadataChecked: gitDirExists,
  findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
