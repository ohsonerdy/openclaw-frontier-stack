#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Module = require('module');
const { scan } = require('../lib/private-patterns');
const root = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const blockers = [];
function walk(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'release-gate/exports', 'release-gate/reports'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const rel = prefix ? path.posix.join(prefix, ent.name) : ent.name;
    if (ent.isDirectory()) out.push(...walk(full, rel)); else if (ent.isFile()) out.push({ full, rel });
  }
  return out;
}
function shippedFiles() {
  const entries = Array.isArray(pkg.files) && pkg.files.length ? pkg.files : ['.'];
  const files = [];
  for (const entry of entries) {
    const clean = entry.replace(/\/$/, '');
    const full = path.join(root, clean);
    if (!fs.existsSync(full)) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) files.push(...walk(full, clean)); else files.push({ full, rel: clean });
  }
  return files.filter((f) => !/\.(png|jpg|jpeg|gif|webp|tgz|zip)$/i.test(f.rel));
}
const files = shippedFiles();
for (const f of files) {
  const buf = fs.readFileSync(f.full);
  if (buf.includes(0)) continue;
  const findings = scan(f.rel, buf.toString('utf8'));
  if (findings.length) blockers.push({ id: 'private-content', file: f.rel, findings });
}
for (const f of files.filter((x) => /\.(cjs|mjs|js)$/.test(x.rel))) {
  try { cp.execFileSync(process.execPath, ['--check', f.full], { stdio: 'pipe' }); }
  catch (err) { blockers.push({ id: 'js-syntax', file: f.rel, error: String(err.stderr || err.message).slice(0, 800) }); }
}
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {}), ...Object.keys(pkg.peerDependencies || {})]);
const requireRx = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const f of files.filter((x) => /\.(cjs|js)$/.test(x.rel))) {
  const text = fs.readFileSync(f.full, 'utf8');
  let m;
  while ((m = requireRx.exec(text))) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (Module.builtinModules.includes(spec) || Module.builtinModules.includes(spec.replace(/^node:/, ''))) continue;
    const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!declared.has(top)) blockers.push({ id: 'undeclared-dependency', file: f.rel, require: spec });
  }
}

const personaTerms = [
  [89, 111, 114, 117],
  [78, 101, 111],
  [82, 101, 105],
  [67, 111, 110, 115, 116, 114, 117, 99, 116],
  [99, 108, 97, 117, 100, 101, 45, 99, 111, 100, 101, 45, 103, 117, 105],
].map((codes) => String.fromCharCode(...codes));
const publicPersonaRx = new RegExp(`\\b(?:${personaTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
const incidentSha = ['8d885c12c273c8befd9a2', 'd2ce212dcc2a9856ef5'].join('');
const publicIncidentArtifactRx = new RegExp(`\\b${incidentSha}\\b`);
const forbiddenPublicDocs = [
  'docs/incident-postmortem.md',
  'docs/evaluations/rename-audit.md',
  'docs/evaluations/blackboard-adapter.md',
  'docs/evaluations/README.md',
];
for (const rel of forbiddenPublicDocs) {
  if (fs.existsSync(path.join(root, rel))) blockers.push({ id: 'forbidden-public-artifact', file: rel });
}
for (const f of files.filter((x) => /\.(md|json|yml|yaml|txt|js)$/.test(x.rel))) {
  const text = fs.readFileSync(f.full, 'utf8');
  if (publicPersonaRx.test(text)) blockers.push({ id: 'public-persona-name', file: f.rel });
  if (publicIncidentArtifactRx.test(text)) blockers.push({ id: 'public-incident-sha', file: f.rel });
}

const staleRx = /\b(not been approved|not approved|not published|draft candidate|readyForGithubUpload:\s*false|No GitHub push[^\n]*authorized)\b/i;
for (const f of files.filter((x) => /\.(md|json|yml|yaml|txt)$/.test(x.rel))) {
  const text = fs.readFileSync(f.full, 'utf8');
  if (staleRx.test(text)) blockers.push({ id: 'stale-release-state', file: f.rel });
}
const output = { schema: 'openclaw-frontier.sentinel-gate.v1', generatedAt: new Date().toISOString(), ok: blockers.length === 0, scannedFiles: files.length, blockers };
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
