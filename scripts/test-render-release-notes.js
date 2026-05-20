#!/usr/bin/env node
'use strict';

// Node-native tests for scripts/render-release-notes.js.
//
// Synthesizes a fake CHANGELOG.md and a git-log/shortstat fixture, runs the
// renderer with OPENCLAW_RELEASE_NOTES_GIT_FIXTURE set so no real git
// invocation happens, then asserts the produced markdown has every required
// section and that the numeric stats round-trip correctly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const renderer = path.join(root, 'scripts', 'render-release-notes.js');

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function assertTrue(cond, label) {
  if (!cond) throw new Error(label + ': expected truthy');
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ': expected ' + e + ' got ' + a);
}
function assertIncludes(haystack, needle, label) {
  if (typeof haystack !== 'string' || haystack.indexOf(needle) === -1) {
    throw new Error(label + ': expected output to include ' + JSON.stringify(needle));
  }
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'render-release-notes-'));
}

function writeFakeChangelog(dir) {
  const text = [
    '# Changelog',
    '',
    '## 2026-05-19 — v0.8.0 — Cron, doctor, supply chain, webhooks, bundles',
    '',
    'Status: candidate.',
    '',
    'Lands the Hermes ports surfaced by v0.7.0: cron scheduler, openclaw doctor, supply-chain advisory, webhook subscriptions, plus curated skill bundles.',
    '',
    '### Added — cron scheduler',
    '',
    '- `cron/` with persistent JSONL ledger.',
    '',
    '### Added — openclaw doctor',
    '',
    '- Health check command.',
    '',
    '### Migration',
    '',
    'Operators on v0.7.0 should regenerate their hook allowlist via `openclaw doctor --rewrite-allowlist`.',
    '',
    '### Notes',
    '',
    '- 75 skills validate.',
    '',
    '## 2026-05-19 — v0.7.0 — Older release',
    '',
    'Status: published.',
    '',
    'Previous release.',
    '',
    '### Added',
    '',
    '- Prior content.',
    '',
  ].join('\n');
  const p = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(p, text);
  return p;
}

function writeFixture(dir, payload) {
  const p = path.join(dir, 'git-fixture.json');
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

function runRenderer(env, args, cwd) {
  const result = spawnSync(process.execPath, [renderer, ...args], {
    cwd: cwd || root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
  };
}

test('full happy path: every section present and stats math correct', () => {
  const dir = mkTmp();
  const changelog = writeFakeChangelog(dir);
  const fixture = writeFixture(dir, {
    resolvedPrev: 'v0.7.0',
    log: [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa feat: cron scheduler',
      '',
      ' 12 files changed, 800 insertions(+), 50 deletions(-)',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb feat: doctor command',
      '',
      ' 5 files changed, 200 insertions(+), 10 deletions(-)',
      'cccccccccccccccccccccccccccccccccccccccc fix: typo',
      '',
      ' 1 file changed, 1 insertion(+)',
      '',
    ].join('\n'),
    skillCountPrev: 68,
    skillCountTarget: 75,
  });
  const outPath = path.join(dir, 'v0.8.0.md');

  const result = runRenderer(
    { OPENCLAW_RELEASE_NOTES_GIT_FIXTURE: fixture },
    [
      '--version', 'v0.8.0',
      '--out', outPath,
      '--changelog', changelog,
      '--root', dir,
    ],
    dir,
  );
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.parsed, 'renderer emitted JSON summary');
  assertEqual(result.parsed.ok, true, 'ok flag');
  assertEqual(result.parsed.version, 'v0.8.0', 'version echo');
  assertEqual(result.parsed.prev, 'v0.7.0', 'prev tag');
  assertEqual(result.parsed.stats.commits, 3, 'commit count');
  assertEqual(result.parsed.stats.filesChanged, 18, 'files changed sum');
  assertEqual(result.parsed.stats.insertions, 1001, 'insertions sum');
  assertEqual(result.parsed.stats.deletions, 60, 'deletions sum');
  assertEqual(result.parsed.skills.prev, 68, 'skills prev');
  assertEqual(result.parsed.skills.target, 75, 'skills target');
  assertEqual(result.parsed.hasMigration, true, 'has migration section');

  assertTrue(fs.existsSync(outPath), 'output file exists');
  const out = fs.readFileSync(outPath, 'utf8');
  assertIncludes(out, '# Release notes — v0.8.0', 'header');
  assertIncludes(out, 'Date: 2026-05-19', 'date line');
  assertIncludes(out, 'Title: Cron, doctor, supply chain, webhooks, bundles', 'title line');
  assertIncludes(out, 'Previous tag: v0.7.0', 'previous tag line');
  assertIncludes(out, '## Summary', 'summary section');
  assertIncludes(out, 'Lands the Hermes ports surfaced by v0.7.0', 'summary paragraph');
  assertIncludes(out, '## Stats', 'stats section');
  assertIncludes(out, '- Commits: 3', 'commit count line');
  assertIncludes(out, '- Files changed: 18', 'files changed line');
  assertIncludes(out, '- Insertions: 1001', 'insertions line');
  assertIncludes(out, '- Deletions: 60', 'deletions line');
  assertIncludes(out, '- Skill catalog: 68 -> 75 (delta 7)', 'skill delta line');
  assertIncludes(out, '## Highlights', 'highlights section');
  assertIncludes(out, '- Added — cron scheduler', 'highlight 1');
  assertIncludes(out, '- Added — openclaw doctor', 'highlight 2');
  assertIncludes(out, '- Migration', 'migration appears as highlight');
  assertIncludes(out, '## Migration notes', 'migration section');
  assertIncludes(out, 'rewrite-allowlist', 'migration body');
  assertIncludes(out, '## Full changelog', 'full changelog section');
  assertIncludes(out, '> 2026-05-19 — v0.8.0 — Cron, doctor, supply chain, webhooks, bundles', 'changelog anchor');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zero commits and no migration: still emits every required section', () => {
  const dir = mkTmp();
  const text = [
    '# Changelog',
    '',
    '## 2026-05-20 — v0.9.0 — Tiny patch',
    '',
    'Status: candidate.',
    '',
    'Tiny patch release with no migration steps.',
    '',
    '### Notes',
    '',
    '- nothing to migrate.',
    '',
  ].join('\n');
  const changelog = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(changelog, text);

  const fixture = writeFixture(dir, {
    resolvedPrev: 'v0.8.0',
    log: '',
    skillCountPrev: 75,
    skillCountTarget: 75,
  });
  const outPath = path.join(dir, 'v0.9.0.md');
  const result = runRenderer(
    { OPENCLAW_RELEASE_NOTES_GIT_FIXTURE: fixture },
    [
      '--version', 'v0.9.0',
      '--out', outPath,
      '--changelog', changelog,
      '--root', dir,
    ],
    dir,
  );
  assertEqual(result.exitCode, 0, 'exit code');
  assertEqual(result.parsed.stats.commits, 0, 'zero commits');
  assertEqual(result.parsed.stats.filesChanged, 0, 'zero files changed');
  assertEqual(result.parsed.stats.insertions, 0, 'zero insertions');
  assertEqual(result.parsed.skills.target - result.parsed.skills.prev, 0, 'zero skill delta');
  assertEqual(result.parsed.hasMigration, false, 'no migration');

  const out = fs.readFileSync(outPath, 'utf8');
  assertIncludes(out, '- Commits: 0', 'zero commits line');
  assertIncludes(out, '- Skill catalog: 75 -> 75 (delta 0)', 'zero skill delta line');
  assertIncludes(out, '## Highlights', 'highlights section present');
  assertTrue(out.indexOf('## Migration notes') === -1, 'no migration section emitted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unknown version: non-zero exit and clear error', () => {
  const dir = mkTmp();
  const changelog = writeFakeChangelog(dir);
  const fixture = writeFixture(dir, {
    resolvedPrev: null, log: '', skillCountPrev: 0, skillCountTarget: 0,
  });
  const outPath = path.join(dir, 'v9.9.9.md');
  const result = runRenderer(
    { OPENCLAW_RELEASE_NOTES_GIT_FIXTURE: fixture },
    [
      '--version', 'v9.9.9',
      '--out', outPath,
      '--changelog', changelog,
      '--root', dir,
    ],
    dir,
  );
  assertTrue(result.exitCode !== 0, 'non-zero exit');
  assertIncludes(result.stderr, 'no CHANGELOG entry for v9.9.9', 'error message');
  assertTrue(!fs.existsSync(outPath), 'no output written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderer unit: parseGitLogStats parses multi-commit shortstat block', () => {
  const mod = require('./render-release-notes');
  const parsed = mod.parseGitLogStats([
    '1234567 first commit',
    '',
    ' 4 files changed, 100 insertions(+), 20 deletions(-)',
    '89abcde second commit',
    '',
    ' 2 files changed, 30 insertions(+)',
    '',
  ].join('\n'));
  assertEqual(parsed.totalCommits, 2, 'commit count');
  assertEqual(parsed.totalFilesChanged, 6, 'files changed');
  assertEqual(parsed.totalInsertions, 130, 'insertions');
  assertEqual(parsed.totalDeletions, 20, 'deletions');
});

test('renderer unit: compareVersions sorts semver correctly', () => {
  const mod = require('./render-release-notes');
  assertTrue(mod.compareVersions('v0.6.0', 'v0.7.0') < 0, 'v0.6.0 < v0.7.0');
  assertTrue(mod.compareVersions('v1.0.0', 'v0.9.9') > 0, 'v1.0.0 > v0.9.9');
  assertTrue(mod.compareVersions('v0.7.0', 'v0.7.0') === 0, 'equal');
});

let failed = 0;
const results = [];
for (const c of cases) {
  try {
    c.fn();
    results.push({ name: c.name, ok: true });
  } catch (err) {
    failed += 1;
    results.push({ name: c.name, ok: false, error: String(err.message || err) });
  }
}

const summary = {
  schema: 'openclaw-frontier.render-release-notes-test.v1',
  ok: failed === 0,
  total: cases.length,
  failed,
  results,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(failed === 0 ? 0 : 1);
