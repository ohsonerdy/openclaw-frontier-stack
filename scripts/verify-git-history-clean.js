#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan } = require('../release-gate/lib/private-patterns');

const root = path.resolve(__dirname, '..');
const allowPath = /^(scripts\/verify-git-history-clean\.js|release-gate\/lib\/private-patterns\.js|\.github\/workflows\/verify-package\.yml|templates\/github\/workflows\/verify-package\.yml\.template)$/;

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function listCommits() {
  try {
    return git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return [];
  }
}

function listFiles(commit) {
  return git(['ls-tree', '-r', '--name-only', commit]).trim().split(/\r?\n/).filter(Boolean);
}

function fileText(commit, file) {
  try {
    const buf = execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
    if (buf.includes(0)) return null;
    if (buf.length > 2 * 1024 * 1024) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const commits = listCommits();
const findings = [];
for (const commit of commits) {
  for (const file of listFiles(commit)) {
    const rel = file.replace(/\\/g, '/');
    if (allowPath.test(rel)) continue;
    if (/^(node_modules|release-gate\/exports|release-gate\/reports|release-gate\/artifacts)\//.test(rel)) continue;
    const text = fileText(commit, file);
    if (!text) continue;
    const hits = scan(rel, text);
    for (const hit of hits) findings.push({ commit: commit.slice(0, 12), ...hit, match: '[redacted]' });
    if (findings.length >= 50) break;
  }
  if (findings.length >= 50) break;
}

const ok = findings.length === 0;
console.log(JSON.stringify({ schema: 'openclaw-frontier.git-history-clean.v1', ok, commits: commits.length, findings }, null, 2));
process.exit(ok ? 0 : 1);