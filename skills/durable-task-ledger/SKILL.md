---
name: durable-task-ledger
description: Use when a task will span multiple subagents, multiple sessions, or multiple files. Append-only JSONL ledger of task claims, path claims, and result receipts prevents parallel agents from stomping on each other. Triggers when the user dispatches parallel subagents (often via superpowers' dispatching-parallel-agents skill), kicks off a multi-step refactor across files, or asks "who owns this task?" or "what's the state of X?". For in-session task tracking, prefer TodoWrite. For coordination across sessions or subagents, use this skill.
when_to_use: User dispatches parallel subagents (often via superpowers' dispatching-parallel-agents skill), kicks off a multi-step refactor across files, or asks "who owns this task?" / "what's the state of X?"
metadata:
  version: 0.1.0
---

# Durable task ledger

When work spans subagents or sessions, in-conversation state is not enough.
Persist coordination to a JSONL ledger so:

- Subagents see each other's claims and don't stomp on the same path.
- Failed subagents leave a trail you can reconstruct.
- Re-entering a session can resume from the ledger.
- The orchestrator (you, or a parent agent) has a single source of truth
  that survives a context reset.

The ledger is implemented in `lib/blackboard.js`. It uses an mkdir-based
lock (atomic across POSIX and Windows), JSONL append-only writes with
fsync, and a public-safety scan on every record. Paths must be
workspace-relative; absolute paths, parent-directory escapes, and
secret-like segment names (`.env`, `*.pem`, `secret-*`, etc.) are
rejected before they hit disk.

## Procedure

### Step 1 — Initialize the ledger

```js
const { createLedger } = require('<plugin-dir>/lib/blackboard');
const ledger = createLedger({
  ledgerPath: '.openclaw/task-ledger.jsonl',
});
```

The ledger creates the parent directory on first append. The default
location is `<cwd>/blackboard.jsonl`; for OpenClaw projects, use
`.openclaw/task-ledger.jsonl` so it sits alongside other agent state.

### Step 2 — Claim the task

Before doing the work, record the claim:

```js
ledger.claimTask({
  agent: 'agent-1',
  taskId: 'refactor-router-2026-05-18',
  summary: 'Extract route table from src/router.js into src/routes/',
});
```

`taskId` must be a simple identifier (letters, digits, `._:-`). It's the
join key for everything that follows.

### Step 3 — Claim each path before editing

Before editing a shared file, claim it:

```js
ledger.claimPath({
  agent: 'agent-1',
  taskId: 'refactor-router-2026-05-18',
  path: 'src/router.js',
  mode: 'write',
  reason: 'Extracting handler registration to routes/index.js',
});
```

The ledger rejects with `BlackboardValidationError` if another agent
holds the claim. Read the error — it includes `claimedBy` and `taskId`
of the existing claim. Coordinate with that agent (or its operator); do
not bypass.

Re-claiming with the SAME agent and SAME taskId is idempotent. This
matters for retries.

### Step 4 — Release when done with that path

```js
ledger.releasePath({
  agent: 'agent-1',
  taskId: 'refactor-router-2026-05-18',
  path: 'src/router.js',
  reason: 'Refactor complete; new owner is review.',
});
```

Releases are durable. The snapshot reducer removes the claim from the
active set when it sees a release from the same agent/task.

### Step 5 — Record the result

```js
ledger.recordResult({
  agent: 'agent-1',
  taskId: 'refactor-router-2026-05-18',
  ok: true,
  summary: 'Extracted route table; 12 handlers migrated. No behavior changes.',
  artifacts: ['src/router.js', 'src/routes/index.js', 'src/routes/auth.js'],
});
```

`ok: false` marks the task `failed` in the snapshot. `artifacts` are
workspace-relative paths; absolute or secret-shaped paths are rejected.

### Step 6 — Read the snapshot

```js
const state = ledger.snapshot();
console.log(state.tasks);        // by taskId
console.log(state.pathClaims);   // active path holders
console.log(state.facts);        // recorded facts
console.log(state.decisions);    // recorded decisions
console.log(state.results);      // all task results, ok and failed
```

The snapshot is a pure reduction over the JSONL log; it's safe to call
repeatedly. Tasks transition `claimed -> done | failed` based on the
last result record.

## Optional record kinds

Beyond task and path coordination, the ledger supports:

- `recordFact({ agent, subject, value, evidence })` — a stable assertion
  with optional evidence file references.
- `recordDecision({ agent, taskId, decision, status, rationale })` —
  a decision with a short rationale.

Use these sparingly. They're for cross-session decisions that need to
survive context resets, not for play-by-play narration.

## What you must NEVER do

- **Bypass the lock by writing JSONL lines manually.** The lock exists
  for a reason. Concurrent writers will interleave bytes and corrupt
  the log. If you need to seed the ledger, use the API.
- **Claim a path "speculatively" without intending to edit it.** That
  blocks others for no reason and creates phantom claims that nobody
  releases.
- **Use this for ephemeral state.** TodoWrite is the right tool for
  in-session task tracking. The ledger is for cross-session, cross-agent
  state that must survive a context reset or a subagent crash.
- **Mix this ledger with the OpenClaw mesh's blackboard.** They are
  separate systems with separate scopes. This is a per-project local
  ledger for agent session coordination. The mesh blackboard is
  for inter-process coordination over the signed bus.
- **Store private content in record fields.** The public-safety scan
  rejects records that contain home paths, private keys, IP addresses
  in RFC1918/CGNAT space, or API token shapes. If a record is being
  rejected, the fix is to redact, not to disable the scan.

## Cleanup

The ledger is append-only. **Do not truncate.** If you need a fresh
start, move the file aside; don't delete it. Past entries are evidence
of past work and may be referenced by other agents or by audit logs.

For projects that accumulate too many entries to load efficiently, the
right tool is a snapshot file: read the JSONL, compute
`ledger.snapshot()`, write the result as a separate `*.snapshot.json`,
and archive the JSONL with a date suffix. Future runs can warm-start
from the snapshot.

## Related skills

- `safe-public-release` — when the multi-step work ends in publishing
  the result to a public remote.
- `verified-history-scan` — when you want to audit the repo state
  separately from the ledger state.
- Superpowers' `dispatching-parallel-agents` — the upstream pattern
  this skill complements. Dispatch fans out work; the ledger keeps the
  fan-out from colliding.
