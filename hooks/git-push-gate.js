#!/usr/bin/env node
'use strict';

/**
 * git-push-gate.js — PreToolUse hook for Bash commands matching `git push`.
 *
 * Receives the Bash command via stdin. Resolves the target remote URL.
 * If the remote is on github.com (or any other public host the operator
 * extends below), runs the full release gate:
 *
 *   1. scripts/verify-git-history-clean.js  — full git history scan
 *   2. release-gate/scripts/verify-owner-upload-approval.js — only if approval file present
 *
 * Non-zero exit blocks the push. Operator-installed hook scripts are
 * resolved relative to THIS file's location, but verifier scripts run
 * with cwd = the repo being pushed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HISTORY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-git-history-clean.js');
const APPROVAL_SCRIPT = path.join(REPO_ROOT, 'release-gate', 'scripts', 'verify-owner-upload-approval.js');

// Public-host regex. Extend via env var if the operator self-hosts another
// public forge. Comma-separated hostnames, no protocol.
const PUBLIC_HOSTS = new RegExp(
  '(?:github\\.com|gitlab\\.com|bitbucket\\.org|codeberg\\.org' +
    (process.env.FRONTIER_PUBLIC_GIT_HOSTS
      ? '|' + process.env.FRONTIER_PUBLIC_GIT_HOSTS.split(',').map((h) => h.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|')
      : '') +
    ')',
  'i',
);

let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const cmd = stdin.trim();
  if (!/^git\s+push\b/.test(cmd)) {
    process.exit(0);
  }

  // Resolve remote URL. `git push` with no explicit remote uses `origin`.
  let remoteUrl = '';
  try {
    const tokens = cmd.split(/\s+/);
    // tokens[0]=git tokens[1]=push tokens[2]=<remote-or-flag>
    let remoteName = 'origin';
    for (let i = 2; i < tokens.length; i += 1) {
      if (!tokens[i].startsWith('-')) {
        remoteName = tokens[i];
        break;
      }
    }
    remoteUrl = execFileSync('git', ['remote', 'get-url', remoteName], { encoding: 'utf8' }).trim();
  } catch {
    // Couldn't resolve the remote — let git itself report the error.
    process.exit(0);
  }

  if (!PUBLIC_HOSTS.test(remoteUrl)) {
    process.exit(0);
  }

  try {
    execFileSync('node', [HISTORY_SCRIPT], { stdio: 'pipe' });
  } catch (err) {
    process.stderr.write('[git-push-gate] BLOCKED: history scan failed\n');
    process.stderr.write(String(err.stdout || err.stderr || err.message).slice(0, 4000));
    process.exit(1);
  }

  // Approval check only if the file is present in cwd.
  const approvalFile = path.resolve(process.cwd(), process.env.OWNER_APPROVAL_PATH || 'release-gate/owner-upload-approval.json');
  if (fs.existsSync(approvalFile)) {
    try {
      execFileSync('node', [APPROVAL_SCRIPT], { stdio: 'pipe' });
    } catch (err) {
      process.stderr.write('[git-push-gate] BLOCKED: owner approval verification failed\n');
      process.stderr.write(String(err.stdout || err.stderr || err.message).slice(0, 4000));
      process.exit(1);
    }
  }

  process.exit(0);
});
