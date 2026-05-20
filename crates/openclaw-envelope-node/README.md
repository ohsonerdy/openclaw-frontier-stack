# @openclaw/envelope-native

N-API binding for the `openclaw-envelope` Rust crate. Drops the canonical-JSON
encoder, Ed25519 signing, and Ed25519 verification into a native module that
the Node `src/signed-bus/` loader can call when present.

## What it exports

| function | input | output |
|---|---|---|
| `canonicalize(value)` | any JSON value | `Buffer` of UTF-8 canonical bytes, top-level `signature` stripped |
| `stable(value)` | any JSON value | `Buffer` of UTF-8 stable-sorted bytes, no stripping |
| `sign(envelope, keyPath)` | envelope object + PEM path | envelope with `signature` populated |
| `verify(envelope, publicKey)` | envelope + 32-byte raw Ed25519 key | `boolean` |

Byte-for-byte parity with `src/signed-bus/lib/envelope.js` is enforced by
`src/signed-bus/test/envelope-parity.test.js`, which runs both implementations
against the canonical corpus in
`crates/openclaw-envelope/tests/fixtures/canonical-corpus.json`.

## Building locally

You need a Rust toolchain (1.80+) and `@napi-rs/cli`:

```sh
cd crates/openclaw-envelope-node
npm install
npm run build
```

That emits a platform-specific `openclaw-envelope.<triple>.node` next to
`index.js`. The Node-side loader at `src/signed-bus/lib/envelope-loader.js`
picks it up via `require('@openclaw/envelope-native')`; on failure (no
binary, wrong triple, missing toolchain) it transparently falls back to
the pure-JS implementation in `src/signed-bus/lib/envelope.js`.

The binary is built per platform. The published shells under `npm/<triple>/`
are intentionally empty placeholders — a real release pipeline replaces them
with the prebuilt binary for each host.

## Why a binding at all

The pure-JS envelope is already correct and battle-tested. The binding exists
for two reasons:

1. **Throughput.** At fan-out scale (1000-agent local swarm) the canonical
   encoder is hot; the Rust path measurably reduces per-op time. The
   benchmark at `src/signed-bus/bench/envelope-perf.js` reports the delta.
2. **Single source of truth.** The Rust crate is the canonical reference; the
   Node implementation matches it. Wiring Node consumers through the same
   bytes (when available) means a regression in either path is caught by
   the parity test.

Either path is acceptable for production. The release-gate verifier runs the
parity test in both modes when native is built and skips the native arm
otherwise.
