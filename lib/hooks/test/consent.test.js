#!/usr/bin/env node
'use strict';

/**
 * consent.test.js — node-native test for lib/hooks/consent.js.
 *
 * Covered:
 *   - allowlist schema validation
 *   - sha256OfFile matches `crypto.createHash('sha256').update(buf).digest('hex')`
 *   - isAllowed returns true only when (hookId, sha) both match
 *   - isAllowed returns false when the executable bytes change
 *   - addEntry collapses duplicates by hookId; removeEntry drops every match
 *   - saveAllowlist + loadAllowlist round-trip the canonical shape
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const consent = require('../consent.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n  ${err.stack || err.message || err}\n`);
  }
}

function mkTmp(sub) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-consent-${sub}-`));
}

function writeExec(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  try { fs.chmodSync(p, 0o755); } catch (_) { /* windows */ }
  return p;
}

// ---------------------------------------------------------------------------
// 1. schema validation: well-formed allowlists pass.
// ---------------------------------------------------------------------------
check('validateAllowlist accepts an empty allowlist', () => {
  const ok = consent.validateAllowlist({ schema: consent.ALLOWLIST_SCHEMA, entries: [] });
  assert.strictEqual(ok.schema, consent.ALLOWLIST_SCHEMA);
});

check('validateAllowlist accepts a populated allowlist', () => {
  const ok = consent.validateAllowlist({
    schema: consent.ALLOWLIST_SCHEMA,
    entries: [{ hookId: 'h1', executableSha256: 'a'.repeat(64), addedAt: '2026-05-19T00:00:00Z' }],
  });
  assert.strictEqual(ok.entries.length, 1);
});

// ---------------------------------------------------------------------------
// 2. schema validation: bad shapes throw HookConsentError.
// ---------------------------------------------------------------------------
check('validateAllowlist rejects wrong schema string', () => {
  assert.throws(() => consent.validateAllowlist({ schema: 'wrong', entries: [] }), consent.HookConsentError);
});

check('validateAllowlist rejects non-array entries', () => {
  assert.throws(() => consent.validateAllowlist({ schema: consent.ALLOWLIST_SCHEMA, entries: 'not-an-array' }), consent.HookConsentError);
});

check('validateAllowlist rejects entries with bad sha length', () => {
  assert.throws(() => consent.validateAllowlist({
    schema: consent.ALLOWLIST_SCHEMA,
    entries: [{ hookId: 'h', executableSha256: 'abc', addedAt: '2026-05-19T00:00:00Z' }],
  }), consent.HookConsentError);
});

check('validateAllowlist rejects entries missing addedAt', () => {
  assert.throws(() => consent.validateAllowlist({
    schema: consent.ALLOWLIST_SCHEMA,
    entries: [{ hookId: 'h', executableSha256: 'a'.repeat(64) }],
  }), consent.HookConsentError);
});

// ---------------------------------------------------------------------------
// 3. sha256OfFile matches the canonical crypto form.
// ---------------------------------------------------------------------------
check('sha256OfFile matches crypto.createHash(buf).digest(hex)', () => {
  const dir = mkTmp('sha');
  const body = '#!/usr/bin/env node\nconsole.log(JSON.stringify({decision:"continue"}));\n';
  const filePath = writeExec(dir, 'h.js', body);
  const expected = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const got = consent.sha256OfFile(filePath);
  assert.strictEqual(got, expected);
  assert.strictEqual(got.length, 64);
});

check('sha256OfFile throws when path is missing', () => {
  assert.throws(() => consent.sha256OfFile(path.join(os.tmpdir(), `nope-${Date.now()}`)), consent.HookConsentError);
});

// ---------------------------------------------------------------------------
// 4. isAllowed returns true only on exact match.
// ---------------------------------------------------------------------------
check('isAllowed returns true on (hookId, sha) match', () => {
  const dir = mkTmp('match');
  const body = 'console.log("{}")\n';
  const file = writeExec(dir, 'h.sh', body);
  const sha = consent.sha256OfFile(file);
  const allowlist = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'log-hook',
    executableSha256: sha,
  });
  assert.strictEqual(consent.isAllowed(allowlist, 'log-hook', file), true);
});

check('isAllowed returns false when hookId differs', () => {
  const dir = mkTmp('match2');
  const file = writeExec(dir, 'h.sh', 'console.log("{}")\n');
  const allowlist = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'log-hook',
    executableSha256: consent.sha256OfFile(file),
  });
  assert.strictEqual(consent.isAllowed(allowlist, 'other-hook', file), false);
});

check('isAllowed returns false when executable bytes change', () => {
  const dir = mkTmp('drift');
  const file = writeExec(dir, 'h.sh', 'console.log("{}")\n');
  const allowlist = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'log-hook',
    executableSha256: consent.sha256OfFile(file),
  });
  // Mutate the file — sha changes — allowlist no longer matches.
  fs.writeFileSync(file, 'console.log("{\\"decision\\":\\"continue\\"}")\n');
  assert.strictEqual(consent.isAllowed(allowlist, 'log-hook', file), false);
});

check('isAllowed returns false when executable is missing', () => {
  const dir = mkTmp('missing');
  const file = path.join(dir, 'never-existed.sh');
  const allowlist = { schema: consent.ALLOWLIST_SCHEMA, entries: [{ hookId: 'x', executableSha256: 'a'.repeat(64), addedAt: '2026-05-19T00:00:00Z' }] };
  assert.strictEqual(consent.isAllowed(allowlist, 'x', file), false);
});

// ---------------------------------------------------------------------------
// 5. addEntry + removeEntry behaviour.
// ---------------------------------------------------------------------------
check('addEntry collapses duplicate hookIds', () => {
  const a = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'h', executableSha256: 'a'.repeat(64),
  });
  const b = consent.addEntry(a, { hookId: 'h', executableSha256: 'b'.repeat(64) });
  assert.strictEqual(b.entries.length, 1);
  assert.strictEqual(b.entries[0].executableSha256, 'b'.repeat(64));
});

check('removeEntry drops every match for hookId', () => {
  const allowlist = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'h', executableSha256: 'a'.repeat(64),
  });
  const next = consent.removeEntry(allowlist, 'h');
  assert.strictEqual(next.entries.length, 0);
});

check('addEntry rejects bad sha length', () => {
  assert.throws(() => consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'h', executableSha256: 'abc',
  }), consent.HookConsentError);
});

// ---------------------------------------------------------------------------
// 6. saveAllowlist + loadAllowlist round-trip.
// ---------------------------------------------------------------------------
check('saveAllowlist + loadAllowlist round-trip', () => {
  const dir = mkTmp('rt');
  const p = path.join(dir, 'hook-allowlist.json');
  const initial = consent.addEntry({ schema: consent.ALLOWLIST_SCHEMA, entries: [] }, {
    hookId: 'rt-hook', executableSha256: 'c'.repeat(64),
  });
  consent.saveAllowlist(p, initial);
  const loaded = consent.loadAllowlist(p);
  assert.strictEqual(loaded.schema, consent.ALLOWLIST_SCHEMA);
  assert.strictEqual(loaded.entries.length, 1);
  assert.strictEqual(loaded.entries[0].hookId, 'rt-hook');
});

check('loadAllowlist returns empty when file missing', () => {
  const p = path.join(mkTmp('missing-file'), 'never-written.json');
  const loaded = consent.loadAllowlist(p);
  assert.strictEqual(loaded.entries.length, 0);
  assert.strictEqual(loaded.schema, consent.ALLOWLIST_SCHEMA);
});

if (failed > 0) {
  process.stderr.write(`\n${failed} consent test(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('all consent tests passed\n');
