#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const approvalPath = path.join(root, 'release-gate', 'owner-upload-approval.json');
const manifestPath = path.join(root, 'release-gate', 'exports', 'release-manifest-manifest.json');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

if (!fs.existsSync(approvalPath)) {
  console.log(JSON.stringify({
    schema: 'openclaw-frontier.owner-upload-approval.v1',
    ok: true,
    approvalPresent: false,
    readyForExternalUpload: false,
    note: 'No owner approval file present; package verification may pass, but external upload/sign/deploy remains blocked until exact candidate approval exists.'
  }, null, 2));
  process.exit(0);
}

const findings = [];
const approval = readJson(approvalPath);
const required = ['approvedBy', 'approvedAt', 'repo', 'branch', 'candidateManifestSha256', 'candidateTreeSha256', 'remoteBaseSha', 'approvalPhrase'];
for (const key of required) if (!approval[key]) findings.push({ issue: 'missing-field', field: key });
if (approval.repo !== 'ohsonerdy/openclaw-frontier-stack') findings.push({ issue: 'unexpected-repo', repo: approval.repo });
if (approval.branch !== 'main') findings.push({ issue: 'unexpected-branch', branch: approval.branch });

if (fs.existsSync(manifestPath)) {
  const manifest = readJson(manifestPath);
  if (approval.candidateManifestSha256 !== manifest.sha256) findings.push({ issue: 'candidate-manifest-sha-mismatch', expected: manifest.sha256, actual: approval.candidateManifestSha256 });
  const fileListDigest = sha256(Buffer.from(JSON.stringify(manifest.files || []), 'utf8'));
  if (approval.candidateTreeSha256 !== fileListDigest) findings.push({ issue: 'candidate-tree-sha-mismatch', expected: fileListDigest, actual: approval.candidateTreeSha256 });
}

const phrase = String(approval.approvalPhrase || '');
for (const token of [approval.repo, approval.branch, approval.candidateManifestSha256, approval.remoteBaseSha]) {
  if (token && !phrase.includes(token)) findings.push({ issue: 'approval-phrase-not-bound-to-token', tokenName: token === approval.remoteBaseSha ? 'remoteBaseSha' : 'candidate/repo/branch' });
}

const ok = findings.length === 0;
console.log(JSON.stringify({ schema: 'openclaw-frontier.owner-upload-approval.v1', ok, approvalPresent: true, readyForExternalUpload: ok, findings }, null, 2));
process.exit(ok ? 0 : 1);