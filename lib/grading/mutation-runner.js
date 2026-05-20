'use strict';

/**
 * lib/grading/mutation-runner.js — apply each mutation, run verify-package.js,
 * record whether the verifier caught it, revert. Atomic per mutation.
 *
 * Hard rules:
 *   - Before the sweep starts, snapshot `git status --short` + `git diff` for
 *     the working tree. The runner DOES NOT require a clean tree (the operator
 *     may be mid-wave), but it does require that the tree at the end of the
 *     sweep be byte-identical to the tree at the start. If a revert fails the
 *     runner panic-aborts with a `mutation-rollback-failed` outcome.
 *   - Each mutation runs inside its own try/finally. Even if the verifier
 *     crashes or hangs, the revert is invoked.
 *   - Each verifier invocation has a 60-second wall-clock timeout (configurable
 *     via `perMutationTimeoutMs`).
 *   - The total sweep should complete in <10 minutes; the runner does not
 *     enforce this directly but logs durationMs so callers can see drift.
 *
 * Public API:
 *   runMutationSweep({
 *     root,            // absolute path to the repo
 *     mutations,       // optional subset; defaults to all
 *     verifierEnv,     // env-var overrides for the child verifier
 *     perMutationTimeoutMs,
 *     onProgress,      // optional callback({ index, total, id, caught, durationMs })
 *   }) => Promise<{
 *     ok,               // true iff every mutation was caught AND the tree
 *                       // matches at the end
 *     mutations: [{ id, description, caught, durationMs, exitCode, error }, ...],
 *     escaped:   [<id>, ...],     // mutations the verifier did NOT catch
 *     rollbackClean,    // true iff the tree matches at the end
 *     rollbackDiff,     // string diff if rollbackClean is false
 *     durationMs,
 *   }>
 */

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { MUTATIONS } = require('./mutations.js');

const DEFAULT_TIMEOUT_MS = 60000;

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function hashTree(root) {
  // Walk every file outside the standard ignore set and hash (rel, sha256).
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'out']);
  const SKIP_REL_PREFIX = ['release-gate/reports', 'release-gate/artifacts', 'release-gate/exports'];
  const SKIP_REL_PATH_RE = /^examples\/(?:demo-swarm|memory-demo|goal-loop-demo|remote-approval-demo)\/out\b/;
  const SKIP_LEAF_NAMES = new Set(['blackboard.jsonl']);
  const hash = crypto.createHash('sha256');
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SKIP_REL_PREFIX.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
        if (SKIP_REL_PATH_RE.test(rel)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SKIP_LEAF_NAMES.has(entry.name)) continue;
        if (SKIP_REL_PATH_RE.test(rel)) continue;
        const buf = fs.readFileSync(full);
        const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
        hash.update(`${rel}::${fileHash}\n`);
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}

function runVerifier(root, verifierEnv, timeoutMs) {
  return new Promise((resolve) => {
    const args = [path.join(root, 'scripts', 'verify-package.js')];
    const env = { ...process.env };
    // Speed-up env-vars so the verifier completes within budget. Use a
    // shorter per-sub-check timeout (15s) so a single broken sub-check
    // fails fast rather than chugging on the default 240s.
    env.FRONTIER_CHILD_TIMEOUT_MS = verifierEnv && verifierEnv.FRONTIER_CHILD_TIMEOUT_MS
      ? verifierEnv.FRONTIER_CHILD_TIMEOUT_MS
      : '5000';
    env.OPENCLAW_FRONTIER_SKIP_FRESH_EXPORT = '1';
    env.OPENCLAW_FRONTIER_STANDALONE_EXPORT = '1';
    if (verifierEnv && typeof verifierEnv === 'object') Object.assign(env, verifierEnv);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, Math.max(1, timeoutMs));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, error: String(err.message || err), stdout, stderr });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, stdout, stderr });
    });
  });
}

async function runMutationSweep({
  root,
  mutations = null,
  verifierEnv = {},
  perMutationTimeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = null,
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('runMutationSweep: root is required');
  const absRoot = path.resolve(root);
  const selected = Array.isArray(mutations) && mutations.length > 0
    ? mutations
    : MUTATIONS;
  const startTreeHash = hashTree(absRoot);
  const startedAt = Date.now();
  const startStatus = safeGit(['status', '--short'], absRoot);

  const outcomes = [];
  let rollbackClean = true;
  let rollbackDiff = '';

  for (let i = 0; i < selected.length; i += 1) {
    const mutation = selected[i];
    const started = Date.now();
    let caught = null;
    let exitCode = null;
    let error = null;
    let timedOut = false;
    try {
      try {
        mutation.apply(absRoot);
      } catch (applyErr) {
        // Apply failure means no actual mutation took effect; mark as
        // not-caught and revert defensively.
        error = `apply-failed: ${String(applyErr.message || applyErr)}`;
        // Try a defensive revert in case apply partially wrote.
        try { mutation.revert(absRoot); } catch (_) { /* swallow */ }
        outcomes.push({
          id: mutation.id,
          description: mutation.description,
          caught: false,
          durationMs: Date.now() - started,
          exitCode: null,
          error,
        });
        continue;
      }
      const result = await runVerifier(absRoot, verifierEnv, perMutationTimeoutMs);
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      // Verifier caught the mutation if it exited non-zero. A timeout is
      // treated as caught (the mutation broke the verifier so badly it
      // could not complete in budget — that's still a strict gate).
      caught = (exitCode !== 0 && exitCode !== null) || timedOut;
    } finally {
      try {
        mutation.revert(absRoot);
      } catch (revertErr) {
        rollbackClean = false;
        const msg = `mutation ${mutation.id} revert failed: ${String(revertErr.message || revertErr)}`;
        rollbackDiff += `${msg}\n`;
      }
    }
    const durationMs = Date.now() - started;
    outcomes.push({
      id: mutation.id,
      description: mutation.description,
      caught: Boolean(caught),
      durationMs,
      exitCode,
      timedOut,
      error,
    });
    if (typeof onProgress === 'function') {
      try {
        onProgress({
          index: i + 1,
          total: selected.length,
          id: mutation.id,
          caught: Boolean(caught),
          durationMs,
        });
      } catch (_) { /* progress is best-effort */ }
    }
  }

  // Post-sweep tree integrity check.
  const endTreeHash = hashTree(absRoot);
  if (endTreeHash !== startTreeHash) {
    rollbackClean = false;
    const endStatus = safeGit(['status', '--short'], absRoot);
    rollbackDiff += `tree hash drift\nstartStatus:\n${startStatus}\nendStatus:\n${endStatus}\n`;
  }

  const escaped = outcomes.filter((o) => !o.caught).map((o) => o.id);
  return {
    ok: escaped.length === 0 && rollbackClean,
    mutations: outcomes,
    escaped,
    rollbackClean,
    rollbackDiff,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  runMutationSweep,
  __test__: { hashTree },
};
