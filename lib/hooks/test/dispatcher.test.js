#!/usr/bin/env node
'use strict';

/**
 * dispatcher.test.js — node-native test for lib/hooks/dispatcher.js.
 *
 * Covered:
 *   - block decision propagates with the blocker's reason
 *   - context hooks accumulate into result.context
 *   - allowlist enforcement: not-allowed hooks are silently skipped + logged
 *   - timeout enforcement: hook exceeding budget is killed
 *   - malformed stdout: hook is skipped gracefully
 *   - prefix-glob matching: `release-gate:*` resolves to `release-gate:propose`
 *   - back-compat: legacy config with no `events` returns continue
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dispatcher = require('../dispatcher.js');
const consent = require('../consent.js');

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n  ${err.stack || err.message || err}\n`);
  }
}

function mkTmp(sub) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-dispatcher-${sub}-`));
}

/**
 * Write an executable JS hook. The hook reads JSON from stdin and writes
 * the provided body's response to stdout. We invoke it via the current
 * `process.execPath` so the test does not depend on PATH or shebang
 * handling on Windows.
 */
function writeJsHook(dir, name, hookBody) {
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, hookBody);
  try { fs.chmodSync(exe, 0o755); } catch (_) { /* windows: ignore */ }
  return exe;
}

/**
 * Create a one-line shim that the dispatcher can spawn directly. On both
 * POSIX and Windows we instead point the hook config at `process.execPath`
 * (node) and pass the script path as the first arg — but the dispatcher's
 * spawn shape uses the executable directly with no args. So we generate a
 * tiny wrapper exe script that the dispatcher can spawn.
 *
 * On Windows: `spawn('something.js', ...)` fails because .js is not directly
 * executable. To keep the test portable we write a wrapper batch file on
 * Windows and a chmod+x shebang script on POSIX. To stay simple, we use
 * Node's `process.execPath` and write the hook script + invoke via a
 * stand-alone executable wrapper.
 *
 * Simpler approach: write the hook as a node script, but invoke `node` via
 * `process.execPath` as the executable AND set executable bytes to
 * `process.execPath`. That means the SHA-256 in the allowlist must match
 * the bytes of the node binary — fine for our tests.
 */
function buildHookConfig(events) {
  return { schema: dispatcher.HOOKS_SCHEMA_V2, events };
}

/**
 * Helper: write a small JS that loads a per-test response file and prints
 * it to stdout. The hook *bytes* are the same across tests (so its sha is
 * stable across tests), but its behavior is parametrized via env. This
 * keeps the allowlist trivial.
 */
function writeUniversalHook(dir) {
  const code = `
'use strict';
const fs = require('fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const mode = process.env.HOOK_MODE || 'continue';
  if (mode === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: process.env.HOOK_REASON || 'blocked' }));
    process.exit(0);
  }
  if (mode === 'context') {
    process.stdout.write(JSON.stringify({ context: { who: process.env.HOOK_NAME || 'x', payloadEvent: JSON.parse(stdin).eventEcho || null } }));
    process.exit(0);
  }
  if (mode === 'malformed') {
    process.stdout.write('not-valid-json{');
    process.exit(0);
  }
  if (mode === 'timeout') {
    setTimeout(() => process.exit(0), 60000);
    return;
  }
  if (mode === 'continue-and-context') {
    process.stdout.write(JSON.stringify({ decision: 'continue', context: { tag: process.env.HOOK_NAME || 'x' } }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ decision: 'continue' }));
  process.exit(0);
});
`;
  const scriptPath = path.join(dir, 'hook-impl.js');
  fs.writeFileSync(scriptPath, code);
  // We invoke `node hook-impl.js` — wrap that as the "executable" so the
  // dispatcher can spawn it directly. On POSIX we write a shebang script
  // that execs node with the impl path; on Windows we write a .cmd wrapper.
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'hook.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'hook.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  try { fs.chmodSync(sh, 0o755); } catch (_) { /* ignore */ }
  return sh;
}

function allow(exe, hookId) {
  return consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId,
    executableSha256: consent.sha256OfFile(exe),
  });
}

function mergeAllow(allowlist, exe, hookId) {
  return consent.addEntry(allowlist, {
    hookId,
    executableSha256: consent.sha256OfFile(exe),
  });
}

// ---------------------------------------------------------------------------
// 1. continue decision: a single OK hook returns continue.
// ---------------------------------------------------------------------------
async function runAll() {
  await check('continue: single ok hook yields continue', async () => {
    const dir = mkTmp('cont');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'goal:start': [{ id: 'h1', executable: exe }] });
    const result = await dispatcher.dispatch('goal:start', { goalId: 'g-1' }, {
      config: cfg,
      allowlist: allow(exe, 'h1'),
      env: { ...process.env, HOOK_MODE: 'continue' },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.hooks.length, 1);
    assert.strictEqual(result.hooks[0].status, 'ok');
  });

  // -------------------------------------------------------------------------
  // 2. block decision propagates: first blocker's reason wins, subsequent
  // hooks are not spawned.
  // -------------------------------------------------------------------------
  await check('block decision short-circuits the chain', async () => {
    const dir = mkTmp('block');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({
      'release-gate:propose': [
        { id: 'h1', executable: exe },
        { id: 'h2', executable: exe },
      ],
    });
    const allowlist = mergeAllow(allow(exe, 'h1'), exe, 'h2');
    const result = await dispatcher.dispatch('release-gate:propose', { gateId: 'g' }, {
      config: cfg,
      allowlist,
      env: { ...process.env, HOOK_MODE: 'block', HOOK_REASON: 'policy-rejected' },
    });
    assert.strictEqual(result.decision, 'block');
    assert.strictEqual(result.reason, 'policy-rejected');
    assert.strictEqual(result.blockerHookId, 'h1');
    // h2 was never spawned.
    assert.strictEqual(result.hooks.length, 1);
  });

  // -------------------------------------------------------------------------
  // 3. context hooks accumulate.
  // -------------------------------------------------------------------------
  await check('context hooks accumulate into result.context', async () => {
    const dir = mkTmp('ctx');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({
      'lane:dispatch': [
        { id: 'ctx1', executable: exe },
        { id: 'ctx2', executable: exe },
      ],
    });
    const allowlist = mergeAllow(allow(exe, 'ctx1'), exe, 'ctx2');
    const result = await dispatcher.dispatch('lane:dispatch', { eventEcho: 'lane:dispatch' }, {
      config: cfg,
      allowlist,
      env: { ...process.env, HOOK_MODE: 'context', HOOK_NAME: 'a' },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.context.length, 2);
    assert.strictEqual(result.context[0].hookId, 'ctx1');
    assert.strictEqual(result.context[1].hookId, 'ctx2');
    // Each hook saw the same payload.
    assert.strictEqual(result.context[0].context.payloadEvent, 'lane:dispatch');
  });

  // -------------------------------------------------------------------------
  // 4. allowlist enforcement: an entry with a wrong sha is silently skipped
  // and recorded via the onWarn observer as 'hook-not-allowed'.
  // -------------------------------------------------------------------------
  await check('hook not in allowlist is silently skipped + logged', async () => {
    const dir = mkTmp('notallowed');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'goal:end': [{ id: 'gh', executable: exe }] });
    // Allowlist points at the wrong hookId — so isAllowed returns false.
    const allowlist = allow(exe, 'other-hook');
    const warnings = [];
    const result = await dispatcher.dispatch('goal:end', { goalId: 'g' }, {
      config: cfg,
      allowlist,
      onWarn: (w) => warnings.push(w),
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.hooks.length, 1);
    assert.strictEqual(result.hooks[0].status, 'hook-not-allowed');
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].kind, 'hook-not-allowed');
    assert.strictEqual(warnings[0].hookId, 'gh');
  });

  // -------------------------------------------------------------------------
  // 5. timeout enforcement: a hook that never exits is killed and recorded.
  // -------------------------------------------------------------------------
  await check('timeout: hook exceeding budget is killed', async () => {
    const dir = mkTmp('timeout');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'lane:result': [{ id: 'slow', executable: exe, timeoutMs: 200 }] });
    const result = await dispatcher.dispatch('lane:result', { goalId: 'g' }, {
      config: cfg,
      allowlist: allow(exe, 'slow'),
      env: { ...process.env, HOOK_MODE: 'timeout' },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.hooks.length, 1);
    assert.strictEqual(result.hooks[0].status, 'timeout');
    assert.strictEqual(result.hooks[0].timeoutMs, 200);
  });

  // -------------------------------------------------------------------------
  // 6. malformed stdout: hook is skipped gracefully.
  // -------------------------------------------------------------------------
  await check('malformed stdout: hook skipped, dispatch continues', async () => {
    const dir = mkTmp('malformed');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'goal:start': [{ id: 'mal', executable: exe }] });
    const warnings = [];
    const result = await dispatcher.dispatch('goal:start', { goalId: 'g' }, {
      config: cfg,
      allowlist: allow(exe, 'mal'),
      env: { ...process.env, HOOK_MODE: 'malformed' },
      onWarn: (w) => warnings.push(w),
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.hooks[0].status, 'malformed');
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].kind, 'malformed');
  });

  // -------------------------------------------------------------------------
  // 7. prefix-glob: `release-gate:*` resolves for `release-gate:approve`.
  // -------------------------------------------------------------------------
  await check('prefix-glob: release-gate:* matches release-gate:approve', async () => {
    const dir = mkTmp('glob');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'release-gate:*': [{ id: 'wild', executable: exe }] });
    const result = await dispatcher.dispatch('release-gate:approve', { gateId: 'g' }, {
      config: cfg,
      allowlist: allow(exe, 'wild'),
      env: { ...process.env, HOOK_MODE: 'continue' },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.hooks.length, 1);
    assert.strictEqual(result.hooks[0].status, 'ok');
  });

  // -------------------------------------------------------------------------
  // 8. back-compat: legacy config (Stop/PreToolUse only, no `events`) →
  // unknown event names cleanly return continue with no hooks.
  // -------------------------------------------------------------------------
  await check('back-compat: legacy config returns continue with empty hooks', async () => {
    const cfg = { Stop: [{ script: 'x' }], PreToolUse: [] };
    const result = await dispatcher.dispatch('goal:start', { goalId: 'g' }, {
      config: cfg,
      allowlist: { schema: consent.ALLOWLIST_SCHEMA, entries: [] },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.hooks.length, 0);
  });

  // -------------------------------------------------------------------------
  // 9. continue-and-context: an OK hook with both fields contributes context.
  // -------------------------------------------------------------------------
  await check('hook returning continue + context contributes both', async () => {
    const dir = mkTmp('cc');
    const exe = writeUniversalHook(dir);
    const cfg = buildHookConfig({ 'lane:dispatch': [{ id: 'cc', executable: exe }] });
    const result = await dispatcher.dispatch('lane:dispatch', { goalId: 'g' }, {
      config: cfg,
      allowlist: allow(exe, 'cc'),
      env: { ...process.env, HOOK_MODE: 'continue-and-context', HOOK_NAME: 'tag-a' },
    });
    assert.strictEqual(result.decision, 'continue');
    assert.strictEqual(result.context.length, 1);
    assert.strictEqual(result.context[0].context.tag, 'tag-a');
  });

  // -------------------------------------------------------------------------
  // 10. resolveHooks: declared order is preserved, literal beats glob.
  // -------------------------------------------------------------------------
  await check('resolveHooks: literal then glob, in declared order', () => {
    const cfg = buildHookConfig({
      'release-gate:propose': [{ id: 'lit', executable: 'a' }],
      'release-gate:*':       [{ id: 'glob', executable: 'b' }],
    });
    const hooks = dispatcher.resolveHooks(cfg, 'release-gate:propose');
    assert.strictEqual(hooks.length, 2);
    assert.strictEqual(hooks[0].id, 'lit');
    assert.strictEqual(hooks[1].id, 'glob');
  });

  if (failed > 0) {
    process.stderr.write(`\n${failed} dispatcher test(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write('all dispatcher tests passed\n');
}

runAll().catch((err) => {
  process.stderr.write(`unhandled: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
