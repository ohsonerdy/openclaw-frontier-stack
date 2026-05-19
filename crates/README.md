# OpenClaw Frontier Stack — Rust crates (v0.7.0 MVP)

This directory contains the Rust mirror of the three primitive coordination
libraries shipped by the OpenClaw Frontier Stack:

| Rust crate              | JS source                                 | Purpose                                                  |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `openclaw-envelope`     | `src/signed-bus/lib/envelope.js`          | Ed25519-signed envelopes with canonical JSON encoding.   |
| `openclaw-blackboard`   | `src/blackboard/lib/ledger.js`            | JSONL append-only ledger with mkdir-based mutual excl.   |
| `openclaw-taskflow`     | `src/taskflow/lib/taskflow.js`            | In-memory durable task FSM (queued -> done lifecycle).   |

## Why a Rust port

The Node implementation drives every coordination flow today. Two things
motivate a Rust port:

- **Hot-path throughput.** Eval runners, agent daemons, and ledger contenders
  process tens of thousands of records per minute. A statically compiled
  binary with cheap struct copies (vs the JS object allocations) and a real
  threading model is the right substrate.
- **Embeddability.** Rust crates can be linked into other host runtimes
  (Python via PyO3, Go via cgo, Node via N-API) without dragging in a v8
  isolate. The same envelope verifier that runs in Node should run in
  whatever language is in front of the operator.

## Build and test

```sh
# from inside this directory
cargo build --workspace
cargo test --workspace
```

MSRV is pinned in `Cargo.toml` (`rust-version = "1.80"`) so a stable toolchain
released on or after 2024-07-25 is required.

## Interop guarantees (the contract)

These crates are useful only insofar as Node-signed records verify in Rust and
Rust-signed records verify in Node. The guarantees are:

1. **Canonical JSON encoding** — `openclaw_envelope::canonicalize` produces
   the exact bytes that `envelope.js#canonicalize()` produces. The fixture
   corpus at `openclaw-envelope/tests/fixtures/canonical-corpus.json` is a
   set of (input, expected canonical bytes) pairs whose expected values came
   from Node 24's `JSON.stringify` over the same key-sorted input tree. The
   Rust test `fixture_corpus_matches_node_canonical_output` enforces this.

2. **JSONL on-disk format** — the blackboard writes one JSON record per line,
   terminated by `\n` (never `\r\n`). The final byte of the file is `\n`. The
   Rust test `jsonl_format_one_record_per_line_lf_only` enforces this. The
   schema string and field shape match the Node side so a Rust process can
   read a Node-written ledger and vice versa.

3. **FSM transitions** — the same six states (`queued`, `claimed`, `waiting`,
   `done`, `failed`, `blocked`) and the same three result statuses (`ok`,
   `failed`, `blocked`). Terminal-state mutation is rejected; unknown task ids
   return a typed `NotFound`. The state encoded in events is wire-identical to
   the Node implementation.

4. **The H2 fix** — only the top-level `signature` field is stripped from
   canonical bytes; a nested `body.signature` participates in the signature.
   The Rust test `h2_nested_signature_mutation_breaks_verification` is the
   exact equivalent of `nested-signature-tamper.test.js`.

## Status

v0.7.0 MVP. Rust agents can read records written by Node agents and vice
versa, but integration with the Node runtime (the `openclaw-agent` daemon,
the `openclaw` CLI, the harness scripts under `scripts/`) is **not yet
implemented**. The Rust crates compile and test standalone; they do not
participate in `npm run verify` checks beyond being byte-clean on the disk.

## Not in scope (yet)

- FFI bindings (N-API, PyO3, cgo). These crates are pure Rust libraries.
- An async or `tokio`-based runtime story. All ledger I/O is sync; the
  envelope crate is sync. A future `openclaw-agent` daemon will pull in an
  async runtime; this MVP does not.
- A Rust equivalent of `openclaw-agent`, the runner daemon. The daemon is
  the most interesting Rust target for v0.8.0 because it has the most heat
  on per-tick throughput. See the roadmap section below.
- Replacement of `openclaw` CLI commands. The CLI stays in Node for v0.7.0.

## v0.8.0+ roadmap candidates

Concrete next-step targets, roughly in order of leverage:

1. **`openclaw-agent` Rust binary.** A faithful port of the runner loop in
   `bin/openclaw-agent`. The reward is roughly 20-50x faster cold-start and
   ~5x smaller working set, which makes per-task fan-out (currently capped
   by Node startup cost) economically feasible. Depends on these crates plus
   an `openclaw-bus` crate (NATS or in-process channels).
2. **Eval runner.** `scripts/run-skill-evals.js` is the highest-throughput
   verifier in the repo. A Rust port that reuses these crates for record
   validation would unlock running the full eval matrix in CI rather than
   gating on developer machines.
3. **FFI to Node via N-API.** Wrap `openclaw_envelope::verify` and the
   blackboard reader so the Node side can offload verification (currently
   the hottest call in `verify-package.js`).
4. **Harness rewrite.** A subset of `release-gate/scripts/` could move into
   a Rust binary that the Node harness invokes. Marginal value compared to
   the runner daemon, but a clean test-bed for FFI.

## Layout

```
crates/
|-- Cargo.toml                          (workspace root)
|-- README.md                           (this file)
|-- openclaw-envelope/
|   |-- Cargo.toml
|   |-- src/lib.rs
|   |-- tests/
|   |   |-- canonical.rs
|   |   |-- sign_verify.rs
|   |   |-- nested_signature_tamper.rs
|   |   `-- fixtures/canonical-corpus.json
|-- openclaw-blackboard/
|   |-- Cargo.toml
|   |-- src/lib.rs
|   |-- tests/
|   |   |-- append_read.rs
|   |   |-- claim_collision.rs
|   |   `-- snapshot_reducer.rs
`-- openclaw-taskflow/
    |-- Cargo.toml
    |-- src/lib.rs
    `-- tests/
        |-- fsm_happy_path.rs
        `-- fsm_invalid_transitions.rs
```
