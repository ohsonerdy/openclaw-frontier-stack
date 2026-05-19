#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scan } = require('../lib/private-patterns');

const root = path.resolve(__dirname, '..', '..');
const outRoot = path.join(root, 'release-gate', 'exports', 'openclaw-frontier-stack-clean');
const manifestPath = path.join(root, 'release-gate', 'exports', 'release-manifest-manifest.json');

const include = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
  'bundles.json',
  '.gitignore',
  '.npmignore',
  '.github',
  '.githooks',
  '.claude-plugin',
  '.codex-plugin',
  '.cursor-plugin',
  '.opencode',
  'agents',
  'bin',
  'crates',
  'cron',
  'hooks',
  'lib',
  'STATUS.md',
  'docs',
  'EVIDENCE',
  'examples',
  'integration',
  'test',
  'release-gate/checklist.md',
  'release-gate/evidence',
  'release-gate/release-gate-packet-v20260512-0203.md',
  'release-gate/release-notes',
  'release-gate/review-requests',
  'release-gate/reviewer-decision.template.yaml',
  'release-gate/reviewer-decision-schema.md',
  'release-gate/reviewer-decisions',
  'release-gate/lib',
  'release-gate/scripts',
  'release-gate/scorecards',
  'release-gate/supply-chain-allowlist.json',
  'release-gate/hook-allowlist.json',
  'release-gate/test',
  'scripts',
  'skills',
  'src',
  'templates',
  'webhook',
];
const denyParts = new Set(['node_modules', '.git', 'out', 'reports', 'artifacts']);
const denyFilePatterns = [
  /latest-verification\.json$/,
  /REVIEW_STATUS\.md$/,
  /\.bak(?:-|\.|$)/,
  /\.bak-[^/\\]+$/,
];
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shouldSkip(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.some((part) => denyParts.has(part)) || denyFilePatterns.some((re) => re.test(rel));
}
function copyEntry(src, dst, rel, files) {
  if (shouldSkip(rel)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    mkdirp(dst);
    for (const name of fs.readdirSync(src)) copyEntry(path.join(src, name), path.join(dst, name), rel ? `${rel}/${name}` : name, files);
    return;
  }
  if (!st.isFile()) return;
  mkdirp(path.dirname(dst));
  const buf = fs.readFileSync(src);
  if (buf.length < 2 * 1024 * 1024) {
    const text = buf.toString('utf8');
    const findings = scan(rel, text);
    if (findings.length > 0) throw new Error(`private scan failed ${findings[0].pattern} in ${rel}`);
  }
  fs.copyFileSync(src, dst);
  files.push({ path: rel.replace(/\\/g, '/'), bytes: buf.length, sha256: sha256(buf) });
}

rmrf(outRoot);
mkdirp(outRoot);
const files = [];
for (const rel of include) {
  const src = path.join(root, rel);
  if (fs.existsSync(src)) copyEntry(src, path.join(outRoot, rel), rel, files);
}
files.sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  schema: 'openclaw-frontier.release-manifest-manifest.v1',
  generatedAt: new Date().toISOString(),
  exportPath: 'release-gate/exports/openclaw-frontier-stack-clean',
  fileCount: files.length,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  files,
};
manifest.sha256 = sha256(Buffer.from(JSON.stringify(files), 'utf8'));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, exportPath: manifest.exportPath, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, sha256: manifest.sha256 }, null, 2));
