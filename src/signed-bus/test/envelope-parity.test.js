'use strict';

/**
 * envelope-parity.test.js. Byte-for-byte parity check between the pure-JS
 * envelope implementation and the optional N-API binding.
 *
 * The canonical corpus is the same fixture that
 * `crates/openclaw-envelope/tests/canonical.rs` consumes, so a regression in
 * either path fails at least one of the two test surfaces.
 *
 * If `@openclaw/envelope-native` is not built for this host triple, the
 * native arm logs `[skip] native not available` and the test still exits 0.
 * The operator is NOT required to have a Rust toolchain.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = require('../lib/envelope.js');

const CORPUS_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'crates',
  'openclaw-envelope',
  'tests',
  'fixtures',
  'canonical-corpus.json',
);

if (!fs.existsSync(CORPUS_PATH)) {
  console.error(`FAIL canonical corpus missing at ${CORPUS_PATH}`);
  process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
if (!Array.isArray(corpus) || corpus.length === 0) {
  console.error('FAIL canonical corpus is empty');
  process.exit(1);
}

let native = null;
try {
  // eslint-disable-next-line global-require
  native = require('../../../crates/openclaw-envelope-node');
} catch (err) {
  native = null;
}

function nativeUsable(mod) {
  return Boolean(
    mod
    && typeof mod.canonicalize === 'function'
    && typeof mod.stable === 'function',
  );
}

// --- JS arm: every corpus entry must canonicalize to the expected bytes ---

let jsPass = 0;
for (const entry of corpus) {
  const got = js.canonicalize(entry.input);
  assert.strictEqual(
    got,
    entry.canonical,
    `JS canonicalize mismatch for "${entry.name}":\n  want: ${entry.canonical}\n  got:  ${got}`,
  );
  jsPass += 1;
}
console.log(`ok js: ${jsPass}/${corpus.length} canonical-corpus entries match`);

// --- JS stable() round-trip: JSON.stringify of stable form must equal the ---
// --- expected canonical bytes for entries with no top-level signature ------

let jsStablePass = 0;
let jsStableSkip = 0;
for (const entry of corpus) {
  if (Object.prototype.hasOwnProperty.call(entry.input, 'signature')) {
    // `stable()` does NOT strip; canonicalize does. Skip entries that
    // exercise the strip behavior in this arm.
    jsStableSkip += 1;
    continue;
  }
  const got = JSON.stringify(js.stable(entry.input));
  assert.strictEqual(
    got,
    entry.canonical,
    `JS stable+stringify mismatch for "${entry.name}":\n  want: ${entry.canonical}\n  got:  ${got}`,
  );
  jsStablePass += 1;
}
console.log(`ok js: ${jsStablePass}/${corpus.length - jsStableSkip} stable+stringify entries match (${jsStableSkip} skipped: top-level signature)`);

// --- Native arm: same corpus through the binding (when available) -------

if (!nativeUsable(native)) {
  console.log('[skip] native not available — envelope-native binary not built for this host triple');
  console.log('PASS envelope-parity.test.js');
  process.exit(0);
}

let nativeCanonicalPass = 0;
for (const entry of corpus) {
  const buf = native.canonicalize(entry.input);
  const got = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  assert.strictEqual(
    got,
    entry.canonical,
    `native canonicalize mismatch for "${entry.name}":\n  want: ${entry.canonical}\n  got:  ${got}`,
  );
  // And the two paths must agree byte-for-byte.
  assert.strictEqual(
    got,
    js.canonicalize(entry.input),
    `native vs JS canonicalize divergence for "${entry.name}"`,
  );
  nativeCanonicalPass += 1;
}
console.log(`ok native: ${nativeCanonicalPass}/${corpus.length} canonicalize entries byte-equal to JS`);

let nativeStablePass = 0;
let nativeStableSkip = 0;
for (const entry of corpus) {
  if (Object.prototype.hasOwnProperty.call(entry.input, 'signature')) {
    nativeStableSkip += 1;
    continue;
  }
  const buf = native.stable(entry.input);
  const got = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const want = JSON.stringify(js.stable(entry.input));
  assert.strictEqual(
    got,
    want,
    `native vs JS stable divergence for "${entry.name}":\n  want: ${want}\n  got:  ${got}`,
  );
  nativeStablePass += 1;
}
console.log(`ok native: ${nativeStablePass}/${corpus.length - nativeStableSkip} stable entries byte-equal to JS (${nativeStableSkip} skipped: top-level signature)`);

console.log('PASS envelope-parity.test.js');
