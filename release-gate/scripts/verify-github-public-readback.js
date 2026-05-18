#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const ghBin = process.env.GH_BIN || 'gh';
const repo = process.env.GITHUB_REPOSITORY || process.argv[2] || 'ohsonerdy/openclaw-frontier-stack';
const expectedLogin = process.env.EXPECTED_GITHUB_CONTRIBUTOR || 'ohsonerdy';
const expectedEmail = process.env.EXPECTED_GIT_AUTHOR_EMAIL || ['179361416+ohsonerdy', 'users.noreply.github.com'].join('@');

function gh(args) {
  return execFileSync(ghBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

const findings = [];
let contributors = [];
let commit = null;
try {
  contributors = JSON.parse(gh(['api', `repos/${repo}/contributors`])).map((c) => c.login).sort();
} catch (err) {
  findings.push({ issue: 'contributors-api-read-failed', detail: String(err.message || err) });
}
try {
  commit = JSON.parse(gh(['api', `repos/${repo}/commits/main`]));
} catch (err) {
  findings.push({ issue: 'commit-api-read-failed', detail: String(err.message || err) });
}

if (contributors.length !== 1 || contributors[0] !== expectedLogin) {
  findings.push({ issue: 'unexpected-github-contributors-api', expected: [expectedLogin], actual: contributors });
}
if (commit) {
  const checks = [
    ['github_author', commit.author && commit.author.login, expectedLogin],
    ['github_committer', commit.committer && commit.committer.login, expectedLogin],
    ['commit_author_name', commit.commit && commit.commit.author && commit.commit.author.name, expectedLogin],
    ['commit_committer_name', commit.commit && commit.commit.committer && commit.commit.committer.name, expectedLogin],
    ['commit_author_email', commit.commit && commit.commit.author && commit.commit.author.email, expectedEmail],
    ['commit_committer_email', commit.commit && commit.commit.committer && commit.commit.committer.email, expectedEmail],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) findings.push({ issue: 'unexpected-github-commit-attribution', field, expected, actual });
  }
}

const result = {
  schema: 'openclaw-frontier.github-public-readback.v1',
  ok: findings.length === 0,
  repo,
  expected: { contributors: [expectedLogin], email: expectedEmail },
  contributors,
  head: commit ? commit.sha : null,
  findings,
  caveat: 'GitHub web sidebar contributor cache must still be browser-read back after force-push/recreate; API cleanliness alone is not enough for final public approval.',
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
