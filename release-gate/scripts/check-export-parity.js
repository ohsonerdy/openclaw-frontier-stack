#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..', '..');
const exportRoot = path.join(root, 'release-gate', 'exports', 'openclaw-frontier-stack-clean');
const manifestPath = path.join(root, 'release-gate', 'exports', 'release-manifest-manifest.json');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

const findings = [];
if (!fs.existsSync(manifestPath)) findings.push({ issue: 'missing-manifest', path: 'release-gate/exports/release-manifest-manifest.json' });
if (!fs.existsSync(exportRoot)) findings.push({ issue: 'missing-export-root', path: 'release-gate/exports/openclaw-frontier-stack-clean' });

let manifest = null;
if (findings.length === 0) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const diskPaths = new Set(walk(exportRoot));

  for (const rel of manifestPaths) {
    if (!diskPaths.has(rel)) findings.push({ issue: 'manifest-file-missing-on-disk', path: rel });
  }
  for (const rel of diskPaths) {
    if (!manifestPaths.has(rel)) findings.push({ issue: 'disk-file-missing-from-manifest', path: rel });
  }
  for (const file of manifest.files) {
    const full = path.join(exportRoot, file.path);
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const actual = { bytes: buf.length, sha256: sha256(buf) };
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      findings.push({ issue: 'manifest-hash-or-size-mismatch', path: file.path, expected: { bytes: file.bytes, sha256: file.sha256 }, actual });
    }
  }

  const requiredExportPaths = [
    'README.md',
    'package.json',
    '.github/workflows/verify-package.yml',
    'docs/release-scope.md',
    'release-gate/scripts/check-export-parity.js',
    'release-gate/scripts/create-clean-export.js',
    'scripts/verify-package.js',
    'templates/github/SECURITY.md',
  ];
  for (const rel of requiredExportPaths) {
    if (!manifestPaths.has(rel)) findings.push({ issue: 'missing-required-export-path', path: rel });
  }

  const forbiddenParts = new Set(['node_modules', '.git', 'out', 'reports', 'artifacts']);
  for (const rel of diskPaths) {
    const parts = rel.split('/');
    if (parts.some((part) => forbiddenParts.has(part))) findings.push({ issue: 'forbidden-export-path-part', path: rel });
    if (/latest-verification\.json$/.test(rel)) findings.push({ issue: 'forbidden-generated-report', path: rel });
  }

  if (manifest.fileCount !== manifest.files.length) findings.push({ issue: 'manifest-file-count-mismatch', expected: manifest.fileCount, actual: manifest.files.length });
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (manifest.totalBytes !== totalBytes) findings.push({ issue: 'manifest-total-bytes-mismatch', expected: manifest.totalBytes, actual: totalBytes });
  const expectedManifestHash = sha256(Buffer.from(JSON.stringify(manifest.files), 'utf8'));
  if (manifest.sha256 !== expectedManifestHash) findings.push({ issue: 'manifest-list-hash-mismatch', expected: manifest.sha256, actual: expectedManifestHash });
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.release-manifest-parity.v1',
  ok,
  exportPath: 'release-gate/exports/openclaw-frontier-stack-clean',
  fileCount: manifest ? manifest.fileCount : 0,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
