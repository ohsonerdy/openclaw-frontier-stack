#!/usr/bin/env node
'use strict';

/**
 * cron/test/scheduler.test.js — node-native test suite for the
 * openclaw-cron scheduler core and daemon helpers. No test framework;
 * uses node:assert.
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const scheduler = require(path.join(repoRoot, 'cron', 'lib', 'scheduler.js'));
const daemon = require(path.join(repoRoot, 'bin', 'openclaw-cron'));
const { createLedger } = require(path.join(repoRoot, 'src', 'blackboard', 'lib', 'ledger.js'));

let checks = 0;
function test(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (err) {
    process.stderr.write(`FAIL: ${name}\n  ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}

async function testAsync(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`FAIL: ${name}\n  ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}

function mkTmp(sub) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-cron-${sub}-`));
}

// ----------------------------------------------------------------------------
// parseSchedule — coverage of all supported syntaxes.
// ----------------------------------------------------------------------------

test('parseSchedule: all-wildcards', () => {
  const p = scheduler.parseSchedule('* * * * *');
  assert.strictEqual(p.fields[0].size, 60);
  assert.strictEqual(p.fields[1].size, 24);
  assert.strictEqual(p.fields[2].size, 31);
  assert.strictEqual(p.fields[3].size, 12);
  assert.strictEqual(p.fields[4].size, 7);
  assert.deepStrictEqual(p.starOf, [true, true, true, true, true]);
});

test('parseSchedule: single integer', () => {
  const p = scheduler.parseSchedule('0 9 * * *');
  assert.deepStrictEqual(Array.from(p.fields[0]), [0]);
  assert.deepStrictEqual(Array.from(p.fields[1]), [9]);
  assert.strictEqual(p.starOf[0], false);
  assert.strictEqual(p.starOf[2], true);
});

test('parseSchedule: comma list', () => {
  const p = scheduler.parseSchedule('1,5,10 * * * *');
  assert.deepStrictEqual(Array.from(p.fields[0]).sort((a, b) => a - b), [1, 5, 10]);
});

test('parseSchedule: range', () => {
  const p = scheduler.parseSchedule('* 1-5 * * *');
  assert.deepStrictEqual(Array.from(p.fields[1]).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('parseSchedule: step on wildcard (*/15)', () => {
  const p = scheduler.parseSchedule('*/15 * * * *');
  assert.deepStrictEqual(Array.from(p.fields[0]).sort((a, b) => a - b), [0, 15, 30, 45]);
});

test('parseSchedule: step on range (10-30/5)', () => {
  const p = scheduler.parseSchedule('10-30/5 * * * *');
  assert.deepStrictEqual(Array.from(p.fields[0]).sort((a, b) => a - b), [10, 15, 20, 25, 30]);
});

test('parseSchedule: monthly on first (0 0 1 * *)', () => {
  const p = scheduler.parseSchedule('0 0 1 * *');
  assert.deepStrictEqual(Array.from(p.fields[2]), [1]);
});

test('parseSchedule: rejects 4-field expression', () => {
  assert.throws(() => scheduler.parseSchedule('* * * *'), /5 fields/);
});

test('parseSchedule: rejects out-of-range hour', () => {
  assert.throws(() => scheduler.parseSchedule('0 24 * * *'), /out of range/);
});

test('parseSchedule: rejects empty string', () => {
  assert.throws(() => scheduler.parseSchedule(''), /non-empty/);
});

test('parseSchedule: rejects non-numeric step', () => {
  assert.throws(() => scheduler.parseSchedule('*/x * * * *'), /step/);
});

// ----------------------------------------------------------------------------
// nextRun — correctness across daily, hourly, 15-minute, monthly.
// ----------------------------------------------------------------------------

test('nextRun: daily at 09:00 UTC from 08:59', () => {
  const p = scheduler.parseSchedule('0 9 * * *');
  const from = new Date(Date.UTC(2026, 4, 19, 8, 59, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-05-19T09:00:00.000Z');
});

test('nextRun: daily at 09:00 UTC after 09:00 rolls to next day', () => {
  const p = scheduler.parseSchedule('0 9 * * *');
  const from = new Date(Date.UTC(2026, 4, 19, 9, 0, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-05-20T09:00:00.000Z');
});

test('nextRun: hourly on the 0th minute', () => {
  const p = scheduler.parseSchedule('0 * * * *');
  const from = new Date(Date.UTC(2026, 4, 19, 13, 32, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-05-19T14:00:00.000Z');
});

test('nextRun: every 15 minutes', () => {
  const p = scheduler.parseSchedule('*/15 * * * *');
  const from = new Date(Date.UTC(2026, 4, 19, 13, 7, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-05-19T13:15:00.000Z');
});

test('nextRun: monthly on the 1st at 00:00', () => {
  const p = scheduler.parseSchedule('0 0 1 * *');
  const from = new Date(Date.UTC(2026, 4, 19, 13, 7, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-06-01T00:00:00.000Z');
});

test('nextRun: dom + dow OR coupling (5 dom plus Mon)', () => {
  // POSIX cron rule: when both dom and dow are non-star, match if EITHER hits.
  const p = scheduler.parseSchedule('0 0 5 * 1');
  // 2026-05-04 is a Monday -> match via dow
  const from = new Date(Date.UTC(2026, 4, 3, 12, 0, 0));
  const next = scheduler.nextRun(p, from);
  assert.strictEqual(next.toISOString(), '2026-05-04T00:00:00.000Z');
});

// ----------------------------------------------------------------------------
// tick — returns due jobs without back-filling history.
// ----------------------------------------------------------------------------

test('tick: a job firing every minute returns at most once per call', () => {
  const jobs = [{ id: 'every-min', schedule: '* * * * *', role: 'r', subject: 's', body: {} }];
  const lastRun = new Map();
  const now = new Date(Date.UTC(2026, 4, 19, 13, 7, 30));
  const due = scheduler.tick(jobs, lastRun, now);
  assert.strictEqual(due.length, 1);
  assert.ok(due[0].dueAt instanceof Date);
});

test('tick: a future-only job is not returned', () => {
  const jobs = [{ id: 'future-only', schedule: '0 9 * * *', role: 'r', subject: 's', body: {} }];
  const lastRun = new Map();
  const now = new Date(Date.UTC(2026, 4, 19, 8, 30, 0));
  const due = scheduler.tick(jobs, lastRun, now);
  assert.strictEqual(due.length, 0);
});

test('tick: a daily job whose run has passed since last tick fires once', () => {
  const jobs = [{ id: 'daily', schedule: '0 9 * * *', role: 'r', subject: 's', body: {} }];
  const lastRun = new Map([['daily', '2026-05-18T09:00:00.000Z']]);
  const now = new Date(Date.UTC(2026, 4, 19, 9, 1, 0));
  const due = scheduler.tick(jobs, lastRun, now);
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].dueAt.toISOString(), '2026-05-19T09:00:00.000Z');
});

test('tick: invalid schedule surfaces parseError without crashing', () => {
  const jobs = [{ id: 'broken', schedule: 'not a cron expr', role: 'r', subject: 's', body: {} }];
  const due = scheduler.tick(jobs, new Map(), new Date());
  assert.strictEqual(due.length, 1);
  assert.ok(due[0].parseError);
});

// ----------------------------------------------------------------------------
// File-lock contention — two ticks racing; second must abort.
// ----------------------------------------------------------------------------

test('tryAcquireLock: first acquires, second returns false while held', () => {
  const tmp = mkTmp('lock');
  const lockPath = path.join(tmp, 'cron-tick.lock');
  const first = daemon.tryAcquireLock(lockPath);
  assert.strictEqual(first, true);
  const second = daemon.tryAcquireLock(lockPath);
  assert.strictEqual(second, false);
  daemon.releaseLock(lockPath);
  const third = daemon.tryAcquireLock(lockPath);
  assert.strictEqual(third, true);
  daemon.releaseLock(lockPath);
});

// ----------------------------------------------------------------------------
// loadJobs — validates shape, surfaces clear errors.
// ----------------------------------------------------------------------------

test('loadJobs: accepts the shipped template', () => {
  const jobs = daemon.loadJobs(path.join(repoRoot, 'cron', 'jobs.json'));
  assert.ok(Array.isArray(jobs));
  assert.ok(jobs.length >= 2);
  for (const j of jobs) {
    assert.ok(j.id && j.schedule && j.role && j.subject);
  }
});

test('loadJobs: rejects duplicate ids', () => {
  const tmp = mkTmp('jobs');
  const p = path.join(tmp, 'jobs.json');
  fs.writeFileSync(p, JSON.stringify({
    jobs: [
      { id: 'x', schedule: '* * * * *', role: 'r', subject: 's' },
      { id: 'x', schedule: '* * * * *', role: 'r', subject: 's' },
    ],
  }));
  assert.throws(() => daemon.loadJobs(p), /duplicate/);
});

test('loadJobs: rejects bad role id', () => {
  const tmp = mkTmp('jobs2');
  const p = path.join(tmp, 'jobs.json');
  fs.writeFileSync(p, JSON.stringify({
    jobs: [{ id: 'x', schedule: '* * * * *', role: '1-bad', subject: 's' }],
  }));
  assert.throws(() => daemon.loadJobs(p), /role/);
});

// ----------------------------------------------------------------------------
// End-to-end one-tick dispatch — invokes bin/openclaw-cron --once and
// confirms a task-claim landed on the blackboard.
// ----------------------------------------------------------------------------

testAsync('one-tick dispatch writes a task-claim record to the blackboard', async () => {
  const tmp = mkTmp('e2e');
  const blackboard = path.join(tmp, 'blackboard.jsonl');
  const jobs = path.join(tmp, 'jobs.json');
  const lock = path.join(tmp, 'cron-tick.lock');
  const state = path.join(tmp, '.last-run.json');

  fs.writeFileSync(jobs, JSON.stringify({
    jobs: [
      { id: 'unit-fire', schedule: '* * * * *', role: 'orchestrator', subject: 'unit-test-claim', body: { key: 'value' } },
    ],
  }));

  await new Promise((resolve, reject) => {
    execFile(process.execPath, [
      path.join(repoRoot, 'bin', 'openclaw-cron'),
      '--jobs', jobs,
      '--blackboard', blackboard,
      '--lock', lock,
      '--state', state,
      '--once',
      '--quiet',
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`daemon failed: ${err.message}\nstdout=${stdout}\nstderr=${stderr}`));
      resolve();
    });
  });

  const ledger = createLedger({ ledgerPath: blackboard });
  const records = ledger.readRecords();
  const claims = records.filter((r) => r.kind === 'task-claim');
  assert.strictEqual(claims.length, 1, `expected 1 task-claim, got ${claims.length}`);
  assert.strictEqual(claims[0].forRole, 'orchestrator');
  assert.ok(claims[0].summary.includes('unit-test-claim'));
  const facts = records.filter((r) => r.kind === 'fact');
  assert.ok(facts.some((f) => f.subject === 'cron-job:unit-fire'));

  // Second invocation in the same minute should not double-fire — the
  // lastRun state prevents re-emit until the next matching minute.
  await new Promise((resolve, reject) => {
    execFile(process.execPath, [
      path.join(repoRoot, 'bin', 'openclaw-cron'),
      '--jobs', jobs,
      '--blackboard', blackboard,
      '--lock', lock,
      '--state', state,
      '--once',
      '--quiet',
    ], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
  });
  const recordsAfter = createLedger({ ledgerPath: blackboard }).readRecords();
  const claimsAfter = recordsAfter.filter((r) => r.kind === 'task-claim');
  assert.strictEqual(claimsAfter.length, 1, `expected still 1 task-claim after second once, got ${claimsAfter.length}`);
});

(async () => {
  // Drain any async tests queued above via await.
  process.on('exit', () => {
    if (checks > 0) process.stdout.write(`ok ${checks} cron scheduler checks\n`);
  });
})();
