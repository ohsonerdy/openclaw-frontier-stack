'use strict';

/**
 * lib/hooks/dispatcher.js — pure dispatcher for the reference-runtime event-hook
 * lifecycle.
 *
 * `dispatch(eventName, eventPayload, opts)` resolves the hook entries that
 * match the event name (literal or `prefix:*` glob), enforces the consent
 * allowlist, spawns each hook executable with `JSON.stringify(eventPayload)`
 * on stdin, waits up to `opts.timeoutMs` for stdout, and aggregates the
 * results.
 *
 * Each hook may write a JSON object to stdout with two recognized shapes:
 *
 *   - `{ decision: 'continue' | 'block', reason?: string }`
 *   - `{ context: <any-json> }`
 *
 * The dispatcher returns:
 *
 *   `{ decision: 'continue' | 'block', reason: string | null,
 *      context: any[], hooks: HookExecutionRecord[] }`
 *
 * A `block` from any hook short-circuits the rest of the chain: subsequent
 * hooks are not spawned and the first blocker's reason is propagated.
 * Context hooks accumulate into the `context` array in spawn order.
 *
 * Pure module: no global state, no side effects beyond the spawned child
 * processes themselves. Callers own the hook config + allowlist path so the
 * dispatcher is trivially unit-testable from any temp dir.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const consent = require('./consent.js');

const HOOKS_SCHEMA_V2 = 'openclaw-frontier.hooks.v2';
const DEFAULT_TIMEOUT_MS = 5000;
const VALID_DECISIONS = new Set(['continue', 'block']);

class HookDispatcherError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HookDispatcherError';
    this.code = 'HOOK_DISPATCHER';
    this.details = details;
  }
}

/**
 * Read a hooks config file and return the parsed v2 shape. Old-style configs
 * (just `{ Stop, PreToolUse }`) are accepted and reported as `events: {}`
 * — the dispatcher treats unrecognized event names as "no hooks bound" and
 * returns `{ decision: 'continue' }`, so back-compat is automatic.
 */
function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return { schema: HOOKS_SCHEMA_V2, events: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new HookDispatcherError(`hooks config is not valid JSON: ${err.message}`, { configPath });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookDispatcherError('hooks config must be an object', { configPath });
  }
  const events = (parsed.events && typeof parsed.events === 'object' && !Array.isArray(parsed.events))
    ? parsed.events
    : {};
  return { schema: parsed.schema || HOOKS_SCHEMA_V2, events, raw: parsed };
}

/**
 * Resolve every hook bound to `eventName`, including via prefix globs like
 * `release-gate:*`. Returns an array of `{ id, executable, timeoutMs }` in
 * the order they were declared. Hooks that fail basic shape validation are
 * skipped (and reported via the optional `onWarn` callback in spawn-time
 * loop).
 */
function resolveHooks(config, eventName) {
  if (!config || !config.events) return [];
  const out = [];
  const events = config.events;
  const literalList = Array.isArray(events[eventName]) ? events[eventName] : [];
  for (const entry of literalList) {
    const normalized = normalizeEntry(entry, eventName);
    if (normalized) out.push(normalized);
  }
  for (const key of Object.keys(events)) {
    if (key === eventName) continue;
    if (!key.endsWith(':*')) continue;
    const prefix = key.slice(0, -1); // keep the trailing ':'
    if (!eventName.startsWith(prefix)) continue;
    const list = Array.isArray(events[key]) ? events[key] : [];
    for (const entry of list) {
      const normalized = normalizeEntry(entry, key);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

function normalizeEntry(entry, matchedKey) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  const executable = String(entry.executable || '').trim();
  if (!id || !executable) return null;
  let timeoutMs = Number(entry.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  return { id, executable, timeoutMs, matchedKey };
}

/**
 * Spawn one hook executable and resolve with `{ id, status, stdout,
 * decision, reason, context, error }`.
 *
 * The hook is invoked with no args; the event payload is delivered as
 * stdin. Stdout is captured up to a fixed maxBuffer; stderr is captured for
 * diagnostics but never gates the decision. If the process exits with a
 * non-zero code OR writes malformed JSON, we treat the hook as
 * `status: 'malformed'` and skip its contribution.
 *
 * Timeout: if the hook does not exit within `timeoutMs`, we kill it and
 * record `status: 'timeout'`.
 */
function spawnHook({ entry, payload, cwd, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    // Windows cannot directly spawn .cmd/.bat scripts without a shell. We
    // route those through cmd.exe via `shell: true`. POSIX scripts with a
    // shebang line are spawned normally. This is the same trick Node uses
    // internally for npm scripts.
    const isWin = process.platform === 'win32';
    const ext = path.extname(entry.executable).toLowerCase();
    const needsShell = isWin && (ext === '.cmd' || ext === '.bat');
    try {
      child = spawn(entry.executable, [], {
        cwd: cwd || process.cwd(),
        env: env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        id: entry.id,
        executable: entry.executable,
        status: 'spawn-error',
        error: String(err.message || err),
        ms: 0,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...record, ms: Date.now() - started });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* best-effort */ }
      finish({
        id: entry.id,
        executable: entry.executable,
        status: 'timeout',
        timeoutMs: entry.timeoutMs,
      });
    }, entry.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) {
        try { child.kill('SIGKILL'); } catch (_) { /* best-effort */ }
        finish({
          id: entry.id,
          executable: entry.executable,
          status: 'stdout-overflow',
        });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      finish({
        id: entry.id,
        executable: entry.executable,
        status: 'spawn-error',
        error: String(err.message || err),
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      const text = stdout.trim();
      if (!text) {
        // Empty stdout means "no opinion" — treated as continue with no context.
        finish({
          id: entry.id,
          executable: entry.executable,
          status: code === 0 ? 'ok-empty' : 'nonzero-exit',
          exitCode: code,
          signal,
          stderr: stderr.slice(0, 4000),
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        finish({
          id: entry.id,
          executable: entry.executable,
          status: 'malformed',
          stdoutSample: text.slice(0, 200),
          stderr: stderr.slice(0, 4000),
        });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({
          id: entry.id,
          executable: entry.executable,
          status: 'malformed',
          stdoutSample: text.slice(0, 200),
        });
        return;
      }
      const decision = parsed.decision != null ? String(parsed.decision) : null;
      if (decision != null && !VALID_DECISIONS.has(decision)) {
        finish({
          id: entry.id,
          executable: entry.executable,
          status: 'malformed',
          stdoutSample: text.slice(0, 200),
        });
        return;
      }
      finish({
        id: entry.id,
        executable: entry.executable,
        status: 'ok',
        exitCode: code,
        decision,
        reason: parsed.reason != null ? String(parsed.reason) : null,
        context: Object.prototype.hasOwnProperty.call(parsed, 'context') ? parsed.context : undefined,
      });
    });

    // Write the event payload to the child's stdin then close it. Errors on
    // the pipe (e.g. the child exited before reading) are non-fatal — we
    // still wait for the 'close' event below.
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (_) {
      /* the close handler will report status. */
    }
  });
}

/**
 * Top-level dispatch. Returns:
 *
 *   `{ decision, reason, context, hooks }`
 *
 *   - decision: 'continue' if no blocker; 'block' if any hook returns block.
 *   - reason: the reason from the first blocker, or null.
 *   - context: array of context payloads from context-providing hooks, in
 *     spawn order.
 *   - hooks: array of HookExecutionRecord (status, ms, etc) — useful for
 *     observability + tests.
 *
 * On a block decision we still finish recording the blocker, but we do not
 * spawn any subsequent hooks. This bounds the worst-case latency to one
 * hook timeout.
 *
 * Hooks whose (id, executable-sha256) pair is not in the allowlist are
 * silently skipped and recorded with `status: 'hook-not-allowed'`. The skip
 * is silent at the protocol level (no block emitted) but loud at the
 * observability level (the hooks array carries the entry) — this is the
 * reference-runtime safety property.
 */
async function dispatch(eventName, eventPayload, opts = {}) {
  if (!eventName || typeof eventName !== 'string') {
    throw new HookDispatcherError('dispatch: eventName must be a non-empty string');
  }
  const cfg = opts.config || loadConfig(opts.configPath || null);
  const allowlist = opts.allowlist || (opts.allowlistPath ? consent.loadAllowlist(opts.allowlistPath) : { schema: consent.ALLOWLIST_SCHEMA, entries: [] });
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;

  const entries = resolveHooks(cfg, eventName).map((entry) => {
    if (opts.timeoutMs && (!entry.timeoutMs || entry.timeoutMs === DEFAULT_TIMEOUT_MS)) {
      return { ...entry, timeoutMs: Number(opts.timeoutMs) || entry.timeoutMs };
    }
    return entry;
  });

  const hooks = [];
  let blocker = null;
  const context = [];

  for (const entry of entries) {
    const executablePath = path.resolve(cwd, entry.executable);
    if (!consent.isAllowed(allowlist, entry.id, executablePath)) {
      const record = {
        id: entry.id,
        executable: entry.executable,
        status: 'hook-not-allowed',
        eventName,
      };
      hooks.push(record);
      if (onWarn) {
        try { onWarn({ kind: 'hook-not-allowed', hookId: entry.id, executable: entry.executable, eventName }); }
        catch (_) { /* observer is best-effort */ }
      }
      continue;
    }
    const record = await spawnHook({
      entry: { ...entry, executable: executablePath },
      payload: eventPayload,
      cwd,
      env,
    });
    hooks.push(record);
    if (record.status === 'malformed' || record.status === 'timeout' || record.status === 'spawn-error' || record.status === 'stdout-overflow') {
      if (onWarn) {
        try { onWarn({ kind: record.status, hookId: entry.id, executable: entry.executable, eventName, detail: record.error || record.stdoutSample || null }); }
        catch (_) { /* observer is best-effort */ }
      }
      continue;
    }
    if (record.status !== 'ok' && record.status !== 'ok-empty') continue;
    if (record.context !== undefined) context.push({ hookId: entry.id, context: record.context });
    if (record.decision === 'block') {
      blocker = { hookId: entry.id, reason: record.reason || `hook ${entry.id} returned block` };
      break;
    }
  }

  return {
    eventName,
    decision: blocker ? 'block' : 'continue',
    reason: blocker ? blocker.reason : null,
    blockerHookId: blocker ? blocker.hookId : null,
    context,
    hooks,
  };
}

module.exports = {
  HOOKS_SCHEMA_V2,
  DEFAULT_TIMEOUT_MS,
  HookDispatcherError,
  loadConfig,
  resolveHooks,
  dispatch,
  spawnHook,
};
