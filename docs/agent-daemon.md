# openclaw-agent — live agent runner daemon

`openclaw-agent` is the v0.6.0 piece that turns the orchestration harness
from a mock-mode trace generator into a real multi-agent runtime. Each
daemon process runs exactly one role. To stand up a swarm you run one
daemon per role, typically under a supervisor.

This document is the operator guide. The CLI's `--help` covers flags;
this page covers the moving parts, the trust model, and the failure
modes you need to know about before pointing the daemon at a live
blackboard.

## What the daemon IS

- **One role per process.** `openclaw-agent --role builder` is the
  builder's runtime. It only reads `agents/builder/CONTRACT.md`, only
  picks up `task-claim` records addressed to `builder`, and only
  writes records signed `agent: 'builder'`. It is not a swarm; it is
  one cell of the swarm.
- **A polling daemon.** It tails `./blackboard.jsonl` (the JSONL ledger
  produced by `src/blackboard/lib/ledger.js`) on a configurable
  interval. New `task-claim` records that lack a corresponding `result`
  are picked up.
- **A model dispatcher.** For each claim it builds a system prompt
  from the role contract, sends the task summary as the user turn, and
  calls a model backend. The backend abstraction is the same one
  `scripts/run-skill-evals.js` uses — Anthropic OAuth or API key,
  Ollama, vLLM, anything OpenAI-compatible. There is no Anthropic
  lock-in in the runtime.
- **A hard-rule enforcer.** Every model response is scanned against
  the role contract's `What you must NEVER do` list and a small set
  of universal cross-role rules (no `git push`, no `--no-verify`,
  no `SKIP_*` env vars, no private-key blocks). A response that
  trips a rule never becomes a `result` record — it becomes a
  `decision` record with `status: 'blocked'`.

## What the daemon IS NOT

- **Not an orchestrator.** It does not decide which role gets which
  task. That is the orchestrator's job (`bin/openclaw goal`, the goal
  loop, the human dispatcher). The daemon only reacts to claims that
  already exist on the blackboard.
- **Not a release gate.** The release gate is fail-closed on the
  pre-push hook and the sentinel-gate script. The daemon does not
  unlock anything; if its role contract says it cannot do X, it
  cannot do X, and the gate would still catch it if a model tried.
- **Not a write authority over the workspace.** The daemon only ever
  writes to two paths: the blackboard ledger (whatever
  `--blackboard` points at) and the audit log
  (defaults to `.openclaw-agent/audit.ndjson` inside the user's home
  directory; override with `OPENCLAW_AGENT_AUDIT_LOG`).
  It never edits source files. The
  model output is logged; whether anyone acts on it is a separate
  step downstream of the result record.

## Starting a single daemon

```
node bin/openclaw-agent \
  --role builder \
  --blackboard ./blackboard.jsonl \
  --model claude-sonnet-4-6 \
  --poll-interval 1000
```

Auth resolves the same way as `run-skill-evals.js`:

- Anthropic backend (default): `ANTHROPIC_OAUTH_TOKEN` >
  `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`.
- OpenAI-compatible backend (`--endpoint http://localhost:11434
  --api-format openai`): `OPENCLAW_EVAL_API_KEY` > `OPENAI_API_KEY`.
  Localhost endpoints may run with no auth.

For a quick sanity probe against an empty blackboard:

```
node bin/openclaw-agent --role builder --dry-run --once
```

`--dry-run` skips the model call and the result/decision writes;
`--once` exits after a single poll cycle. Together they are a
no-op contract-parse + ledger-read probe — useful for checking that
the daemon can find the role contract and read the ledger before
you wire in an API key.

## Starting a swarm

There is no "swarm process" — you start one daemon per role and let
them share the blackboard. Each daemon's claim-discovery is filtered
by `agent === <role>`, so they do not contend with each other.

A typical local layout:

```
# terminal 1
openclaw-agent --role architect --model claude-opus-4-7 \
  --identity-key ./keys/architect.pem

# terminal 2
openclaw-agent --role builder --model claude-sonnet-4-6 \
  --identity-key ./keys/builder.pem

# terminal 3
openclaw-agent --role researcher --model claude-sonnet-4-6

# terminal 4
openclaw-agent --role reviewer --model claude-sonnet-4-6 \
  --identity-key ./keys/reviewer.pem
```

(Use repo-relative or absolute paths for `--identity-key`. The daemon
will read whatever PEM file you point it at. In production, store keys
in a directory outside the repo and reference them by absolute path.)

Under a supervisor (pm2, systemd, the Windows Service wrapper of your
choice), the same flags apply. The daemon handles SIGINT and SIGTERM
cleanly — it writes a `daemon-stop` audit record and exits 0.

A minimal pm2 ecosystem file (illustrative — not shipped, write your
own):

```js
module.exports = {
  apps: [
    { name: 'oc-architect', script: 'bin/openclaw-agent',
      args: '--role architect --model claude-opus-4-7' },
    { name: 'oc-builder', script: 'bin/openclaw-agent',
      args: '--role builder --model claude-sonnet-4-6' },
    { name: 'oc-reviewer', script: 'bin/openclaw-agent',
      args: '--role reviewer --model claude-sonnet-4-6' },
    { name: 'oc-researcher', script: 'bin/openclaw-agent',
      args: '--role researcher --model claude-sonnet-4-6' },
  ],
};
```

## The signed-result pattern (`--identity-key`)

When you pass `--identity-key <path>`, the daemon loads a PEM-encoded
Ed25519 private key and signs every result and blocked-decision
record it writes. The signature is appended as a separate
`fact` record carrying:

```json
{
  "kind": "fact",
  "agent": "<role>",
  "subject": "signed-result:<taskId>",
  "value": {
    "schema": "openclaw-frontier.agent-result-signature.v1",
    "resultId": "<id of the result record this fact attests>",
    "signature": "<base64 Ed25519 signature over the result record minus its signature field>",
    "outputSha256": "<sha256 of the model output that produced the result>"
  }
}
```

The canonical-JSON shape and verification flow are deliberately the
same as the signed-bus envelope pattern in
`src/signed-bus/lib/envelope.js`. A downstream verifier can:

1. Look up the public key for `<role>` (e.g. via
   `keys/<role>.pub` in the swarm's key directory).
2. Recompute the canonical JSON of the result record (omitting the
   signature field — there isn't one on the result record itself; the
   signature lives on the paired `fact`).
3. `crypto.verify(null, canonical, pub, sigBuf)`.

When to use `--identity-key`:

- Any production-shaped run where you want after-the-fact
  attribution of which key produced which result.
- Any run where two daemons might share the same role name across
  hosts and you need to disambiguate which host signed which work.
- Any run that feeds downstream non-repudiation. The signature is
  not a release approval — that is the security-sentinel's lane —
  but it is enough to prove which daemon wrote which result.

When to skip it:

- Local development. The key adds setup overhead and the unsigned
  result records still validate against the blackboard schema.
- Dry-run probes. `--dry-run` short-circuits before any write
  whether or not `--identity-key` is set.

## Controls when the daemon misbehaves

The daemon is designed to be paranoid. The model can produce
anything; the daemon is the gate between the model and the
blackboard. The controls you have:

- `--dry-run` — picks up tasks, does not call the model, does not
  write results. Useful when you suspect a contract parse or claim
  filter is wrong and want to see which tasks the daemon WOULD pick
  up.
- `--once` — single poll cycle. Combine with `--dry-run` for a
  setup probe; combine without `--dry-run` for cron-driven
  invocations or CI gates.
- `--max-tasks <n>` — stops after N tasks. Pairs well with cron in
  the form "run one task every 5 minutes" without a long-lived
  process.
- `--quiet` — silences stderr progress logging. Audit-log writes
  still happen.
- **The role contract's hard rules** — anything in
  `agents/<role>/CONTRACT.md`'s `What you must NEVER do` section is
  enforced *after* the model returns and *before* the daemon writes
  a result. There is no model-side opt-out for this; the daemon
  parses the contract every turn.

If you need to immediately stop a daemon you do not trust, SIGTERM
the process. The audit log will record the stop event.

## Audit log

Every model call, every blackboard write, every contract parse and
every daemon start/stop is logged as one JSONL line under
`.openclaw-agent/audit.ndjson` inside the user's home directory.
The format is human-readable:

```json
{"ts":"2026-05-19T13:29:07.440Z","event":"task-picked","role":"builder","taskId":"t-fixture-1","summary":"extract router routes"}
{"ts":"2026-05-19T13:29:07.500Z","event":"model-call-failed","role":"builder","taskId":"t-fixture-1","reason":"endpoint unreachable (ECONNREFUSED): http://127.0.0.1:9"}
{"ts":"2026-05-19T13:29:07.520Z","event":"decision-blocked","role":"builder","taskId":"t-fixture-1","reason":"model-unreachable","detail":"endpoint unreachable (ECONNREFUSED): http://127.0.0.1:9","recordId":"decision-99aa5464-..."}
```

The audit log is created with mode `0600`. If the parent directory
does not exist, the daemon creates it on first write.

Override the path with the `OPENCLAW_AGENT_AUDIT_LOG` env var if you
want to centralize audit logs across hosts (e.g. a shared NFS mount)
or send to a separate volume.

The audit log is append-only from the daemon's side. Operators are
free to roll it (logrotate, etc.); the daemon will recreate it on
the next write.

## Failure modes

The daemon distinguishes recoverable failures (write a `decision`
with `status: 'blocked'`, keep going) from terminal failures (exit
non-zero, let the supervisor restart).

### Model unreachable (recoverable)

If `callBackend()` throws — ECONNREFUSED, DNS failure,
non-2xx HTTP status, malformed response body — the daemon writes:

```json
{ "kind": "decision", "agent": "<role>", "taskId": "<id>",
  "decision": "<role>-blocked:<taskId>", "status": "blocked",
  "rationale": "blocked:model-unreachable :: <detail>" }
```

…and continues polling for the next task. The audit log captures the
error text and the timing.

### Hard-rule violation (recoverable)

If the model response contains a forbidden pattern (anything in the
contract's `What you must NEVER do` list, or one of the universal
rules — `git push`, `--no-verify`, `SKIP_FRESH_EXPORT`,
`SKIP_GATE`, or a leaked PEM private-key block header), the
daemon writes:

```json
{ "kind": "decision", "agent": "<role>", "taskId": "<id>",
  "decision": "<role>-blocked:<taskId>", "status": "blocked",
  "rationale": "blocked:hard-rule-violation :: forbidden:git-push" }
```

…and keeps going. The full violation list (including which contract
rule fired and the matched evidence) is in the audit log.

### Blackboard locked (recoverable)

The blackboard ledger uses a directory-lock pattern with a 10s
default timeout and a 30s stale-lock reaper. If the daemon hits the
timeout, the audit log records `ledger-read-failed`, the daemon
sleeps for `--poll-interval` ms, and retries. A stuck lock that
outlasts the stale window will be reaped on the next attempt.

### Contract parse failure (terminal)

If `agents/<role>/CONTRACT.md` is missing, malformed, or lacks the
required sections (Mission, Decision authority, What you must NEVER
do), the daemon exits 1 immediately on startup. There is no
fallback — running without a parseable contract would mean running
without hard-rule enforcement, which is the whole point of the
daemon.

The corollary: anyone editing a role contract MUST keep the section
headers stable. Lower-case "mission" or removing "(must check before
acting)" from the "Hard preconditions" heading will break the
parser. The architect contract is the canonical example to match.

### Bad CLI args (terminal)

Missing `--role`, missing `--model` without `--dry-run`, unknown
flag, unreadable identity key — all exit 2 with a stderr message.

## Trust model

The daemon trusts the model output ONLY to the extent the role
contract allows.

Specifically:

1. **The model never decides what to do.** The role contract decides;
   the daemon parses the contract and sends it as the system prompt.
   The model's job is to produce content that fits inside the lane.
2. **Hard rules are enforced after output, not by the model.** The
   model could absolutely produce text that says "run `git push --no-verify`".
   The daemon refuses to write that as a `result`. It writes a
   blocked `decision` instead. The model cannot trick the daemon by
   asking nicely.
3. **The daemon never writes outside the blackboard and the audit
   log.** No file edits to `src/`, no shell-out, no network calls
   other than the model backend. The daemon is a recorder, not an
   executor. If a downstream consumer of the result acts on it,
   that consumer is the one doing the editing — and that consumer
   has its own gate (the pre-push hook, the sentinel-gate, the
   reviewer's decision).
4. **The signature attests "this daemon produced this result",
   nothing more.** A signed result is not an approval. It is
   accountability. To approve a release you still need the
   security-sentinel; to approve a PR you still need the reviewer.
5. **Contract changes are architect-only.** A model running under
   `--role builder` cannot rewrite `agents/builder/CONTRACT.md` to
   relax its own rules. Architect runs separately, with its own
   contract, and architect-decisions live in
   `release-gate/decisions/`. The architect's contract has its
   own NEVER-do list which the daemon enforces the same way.

## Failure-injection probes

To verify the daemon's hard-rule path without burning model calls,
seed the blackboard with a task addressed to the role you want to
exercise, and point the daemon at an unreachable endpoint:

```
node bin/openclaw-agent \
  --role builder \
  --blackboard ./test-blackboard.jsonl \
  --model dummy \
  --endpoint http://127.0.0.1:9 \
  --api-format openai \
  --once
```

Expected: the daemon picks up the task, fails the model call with
ECONNREFUSED, writes a `decision` record with `status: 'blocked'`
and `rationale` starting with `blocked:model-unreachable`, and exits
0. The audit log will show `model-call-failed` followed by
`decision-blocked`.

This is the same shape as the verification scenario shipped in the
v0.6.0 release notes.

## Compatibility notes

- The daemon is pure Node.js, no new runtime dependencies. The
  optional `nats` dependency is *not* required — the daemon writes
  to the JSONL blackboard, not the signed bus. The signed-bus
  pattern is reused only for the signature shape on result records.
- Node `>= 20` is required (matches `package.json#engines`).
- Windows path handling: pass blackboard paths with forward slashes
  or double-quoted backslash paths. The daemon uses `path.resolve()`
  so both forms collapse to the same absolute path. Relative paths
  resolve from the current working directory.
