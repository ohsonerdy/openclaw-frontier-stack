#!/usr/bin/env node
'use strict';

/*
 * Multi-process blackboard contention eval.
 *
 * This is intentionally local-only and hidden-friendly: child processes are
 * forked without opening consoles. They all race against the same JSONL ledger
 * path. Exactly one worker should acquire the contested path; all workers
 * should acquire their unique paths; the ledger must remain valid JSONL.
 */

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BlackboardLedger,
  parseJsonl,
} = require('../src/blackboard/lib/ledger');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'release-gate', 'reports');
const reportPath = path.join(reportDir, 'latest-blackboard-contention-eval.json');

const WORKERS = Number.parseInt(process.env.OPENCLAW_FRONTIER_CONTENTION_WORKERS || '64', 10);
const MIN_WORKERS = 32;

function workerMain() {
  const [, , , ledgerPath, agent, taskId, contestedPath, uniquePath] = process.argv;
  const board = new BlackboardLedger({ ledgerPath, lockTimeoutMs: 15000, staleLockMs: 30000 });
  const result = {
    agent,
    taskId,
    uniqueClaim: false,
    contestedClaim: false,
    contestedRejected: false,
    error: null,
  };

  try {
    board.claimTask({ agent, taskId, summary: `Contention worker ${agent}` });
    board.claimPath({ agent, taskId, path: uniquePath, reason: 'Unique per-worker path claim.' });
    result.uniqueClaim = true;
    try {
      board.claimPath({ agent, taskId, path: contestedPath, reason: 'Expected one winner among all workers.' });
      result.contestedClaim = true;
    } catch (_) {
      result.contestedRejected = true;
    }
    board.recordResult({
      agent,
      taskId,
      ok: true,
      summary: `Contention worker ${agent} complete.`,
      artifacts: [`out/contention/${agent}.json`],
    });
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  }

  // Prefer the IPC channel: process.send() is delivered reliably to the
  // parent and is not subject to the stdout drain race that bites slow CI
  // runners. Fall back to stdout for safety (e.g. if the IPC channel ever
  // disappears) so the parent's existing stdout parsing still works.
  if (typeof process.send === 'function') {
    try {
      process.send({ openclawContentionResult: result });
    } catch (_) {
      // ignore — fall through to stdout
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

function runWorker(scriptPath, ledgerPath, index) {
  const suffix = String(index).padStart(3, '0');
  const agent = `worker${suffix}`;
  const taskId = `contention-${suffix}`;
  const uniquePath = `src/contention/worker-${suffix}.js`;
  const contestedPath = 'src/contention/shared.js';
  return new Promise((resolve) => {
    const child = cp.fork(
      scriptPath,
      ['--worker', ledgerPath, agent, taskId, contestedPath, uniquePath],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let ipcResult = null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    // The worker sends its structured result over the IPC channel first
    // (reliable FIFO, not subject to the stdout drain race) and also writes
    // the same payload to stdout as a fallback.
    child.on('message', (msg) => {
      if (msg && typeof msg === 'object' && msg.openclawContentionResult) {
        ipcResult = msg.openclawContentionResult;
      }
    });
    // Use 'exit' only to capture the exit code; resolve on 'close' so that
    // any stdout data still in the pipe (e.g. the worker's JSON result line)
    // has been fully drained into our buffer. Listening to 'exit' alone
    // races with stdout drain on slow CI runners and can deliver an empty
    // string here, yielding a "ghost" worker that did all of its on-disk
    // work but whose result counts get dropped.
    child.on('exit', (code) => { exitCode = code; });
    child.on('close', (code) => {
      const finalCode = exitCode != null ? exitCode : code;
      let parsed = null;
      if (ipcResult) {
        parsed = ipcResult;
      } else {
        try {
          parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
        } catch (err) {
          parsed = { agent, taskId, error: `invalid-json:${err.message}` };
        }
      }
      resolve({ code: finalCode, stdout: stdout.trim(), stderr: stderr.trim(), parsed });
    });
  });
}

async function main() {
  if (process.argv[2] === '--worker') {
    workerMain();
    return;
  }

  assert(Number.isInteger(WORKERS) && WORKERS >= MIN_WORKERS, `workers must be >= ${MIN_WORKERS}`);
  const startedAt = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-frontier-contention-'));
  const ledgerPath = path.join(tmp, 'blackboard.jsonl');

  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, index) => runWorker(__filename, ledgerPath, index)),
  );

  const failures = results.filter((result) => result.code !== 0 || result.parsed.error);
  const parsed = results.map((result) => result.parsed);
  const uniqueClaims = parsed.filter((result) => result.uniqueClaim).length;
  const contestedClaims = parsed.filter((result) => result.contestedClaim).length;
  const contestedRejected = parsed.filter((result) => result.contestedRejected).length;

  const raw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const records = parseJsonl(raw, ledgerPath);
  const board = new BlackboardLedger({ ledgerPath });
  const snapshot = board.snapshot();
  const elapsedMs = Date.now() - startedAt;

  const assertions = [
    ['worker-count', results.length === WORKERS],
    ['no-worker-failures', failures.length === 0],
    ['all-unique-paths-claimed', uniqueClaims === WORKERS],
    ['single-contested-winner', contestedClaims === 1],
    ['contested-rejections', contestedRejected === WORKERS - 1],
    ['jsonl-valid', records.length > 0],
    ['snapshot-unique-paths', Object.keys(snapshot.pathClaims).length === WORKERS + 1],
    ['tasks-done', Object.values(snapshot.tasks).filter((task) => task.status === 'done').length === WORKERS],
  ];
  const passed = assertions.filter(([, ok]) => ok).length;
  const score = Math.round((passed / assertions.length) * 100);
  const ok = score >= 99;

  const report = {
    schema: 'openclaw-frontier.blackboard-contention-eval.v1',
    generatedAt: new Date().toISOString(),
    externalEffects: false,
    workers: WORKERS,
    ok,
    score,
    elapsedMs,
    metrics: {
      uniqueClaims,
      contestedClaims,
      contestedRejected,
      records: records.length,
      pathClaims: Object.keys(snapshot.pathClaims).length,
      taskCount: Object.keys(snapshot.tasks).length,
      doneTaskCount: Object.values(snapshot.tasks).filter((task) => task.status === 'done').length,
      failures: failures.length,
    },
    failures: failures.slice(0, 10).map((failure) => ({
      code: failure.code,
      agent: failure.parsed && failure.parsed.agent,
      taskId: failure.parsed && failure.parsed.taskId,
      error: failure.parsed && failure.parsed.error
        ? String(failure.parsed.error).split(/\r?\n/).slice(0, 3).join(' | ')
        : '',
      stderr: failure.stderr ? String(failure.stderr).split(/\r?\n/).slice(0, 3).join(' | ') : '',
    })),
    assertions: assertions.map(([name, passedAssertion]) => ({ name, ok: Boolean(passedAssertion) })),
    notes: [
      'Scratch JSONL ledger only. No live fleet.db, NATS, PM2, Telegram, GitHub, or network access.',
      'Child workers are forked hidden and communicate over stdio/ipc only.',
    ],
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok,
    score,
    workers: WORKERS,
    elapsedMs,
    contestedClaims,
    contestedRejected,
    report: path.relative(process.cwd(), reportPath).replace(/\\/g, '/'),
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
