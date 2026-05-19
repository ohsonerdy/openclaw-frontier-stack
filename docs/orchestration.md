# Orchestration harness — operator guide

This document is the operator-level reference for the OpenClaw Frontier Stack orchestration harness, the `openclaw` engineer CLI, and the autonomous-loops workflow pattern.

Scope: this guide explains the harness, the goal schema, the lane → role dispatch model, how to extend the CLI, and how to wire a new autonomous loop into CI. It does not duplicate the lower-level primitives — those live in `docs/goal-system.md`, `docs/bus-and-blackboard-protocol.md`, `docs/taskflow-result-contracts.md`, and `docs/agent-roster-manifest.md`.

## What the harness IS and IS NOT

The harness IS:

- A pure-Node CLI/script that takes a structured goal record, decomposes it into lanes, and writes one `task-claim` per lane to the blackboard ledger.
- A polling loop that waits for `result` records on the same ledger and then synthesizes an overall trace.
- A mock-mode harness that synthesizes lane results in-process so the loop closes without a live bus, without NATS, and without any agent attached.
- The single source of truth for the canonical `/goal` schema (`openclaw-frontier.goal.v1`).

The harness IS NOT:

- An LLM. It never calls a model. The agents do.
- An agent runtime. It does not start, supervise, or kill agent processes. Agents are run separately (Claude Code session, Codex, Cursor, OpenCode, or any custom worker) and observe the blackboard ledger or signed bus.
- A workflow engine. It does not retry, schedule, or backoff. The autonomous-loops workflow in `.github/workflows/autonomous-loops.yml` is the GitHub-Actions surface that does the recurring orchestration.
- A trust boundary. It does not validate model outputs. Every lane result must come with a receipt that the verifier checks. See "Trust model" below.

## The `/goal` JSON schema

Schema: `openclaw-frontier.goal.v1`. Every goal record must validate against this shape before dispatch.

```json
{
  "schema": "openclaw-frontier.goal.v1",
  "id": "GOAL-FRONTIER-FIXTURE-001",
  "title": "Run a synthetic multi-lane orchestration without live agents attached",
  "status": "active",
  "owner": "orchestrator",
  "source": "examples/goal-loop-demo/goal-fixture.json",
  "definitionOfDone": "Every lane has a receipt with a non-empty verdict and the orchestrator produces a synthesis trace.",
  "cadence": { "operatorUpdateMinutes": 30, "channel": "operator-chat" },
  "lanes": [
    {
      "name": "implementation",
      "role": "builder",
      "summary": "Author the change set described by the goal.",
      "expects": ["patch artifact", "smoke test plan"]
    },
    {
      "name": "documentation",
      "role": "docs",
      "summary": "Document the change in operator-facing surface.",
      "expects": ["doc diff", "changelog line"]
    },
    {
      "name": "verification",
      "role": "verifier",
      "summary": "Run the verifier loop and capture receipts.",
      "expects": ["verification report", "lane verdicts"]
    },
    {
      "name": "release-packaging",
      "role": "release_manager",
      "summary": "Bundle the artifact for release.",
      "expects": ["release manifest"]
    },
    {
      "name": "final-approval",
      "role": "sentinel",
      "summary": "Gate the release on Sentinel policy.",
      "expects": ["sentinel decision"]
    }
  ],
  "green": [],
  "red": ["No verifier receipt yet"]
}
```

Required fields after normalization:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Simple task id; lowercased, hyphenated, max 96 chars. CLI prompts get a slugged id automatically. |
| `title` | string | 1..200 chars. |
| `lanes` | array | At least one lane. |
| `lanes[].name` | string | Simple task id; unique within the goal. |
| `lanes[].role` | string | Simple agent id (lowercase, `[A-Za-z][A-Za-z0-9_-]*`). |
| `lanes[].summary` | string | Up to 500 chars. |

Optional fields preserved through normalization:

| Field | Default | Notes |
| --- | --- | --- |
| `status` | `active` | Operator-set lifecycle state. |
| `owner` | `orchestrator` | Agent id that owns the goal. |
| `source` | `unknown` | Origin: operator-chat, ticket, file, etc. |
| `definitionOfDone` | derived | Human-readable bar. |
| `cadence` | `{ operatorUpdateMinutes: 30, channel: 'operator-chat' }` | Operator update cadence. |
| `lanes[].expects` | `[]` | Up to 16 short labels describing expected artifacts. |
| `green` | `[]` | Verified facts. |
| `red` | `[]` | Outstanding blockers. |

Invalid goals (missing title, empty lanes, duplicate lane names, secret-like role names) are rejected with a `GoalValidationError`. The CLI prints the error and exits 2.

## Lane → role dispatch model

A lane is a unit of work owned by exactly one role. The mapping is intentional and 1:1: when the orchestrator writes a `task-claim` for lane `verification`, the agent registered for role `verifier` is expected to pick it up.

The harness performs the dispatch by writing one record per lane to the blackboard ledger via `BlackboardLedger.claimTask`:

```
{
  "schema": "openclaw-frontier.blackboard-ledger.v1",
  "kind": "task-claim",
  "agent": "orchestrator",
  "taskId": "<goalId>.<laneName>",
  "summary": "[<goalId>] <lane.summary>",
  "status": "claimed",
  "ts": "<ISO 8601>"
}
```

The orchestrator does not impersonate the lane role; the claim is owned by `orchestrator`. The live agent observes the ledger, picks up its lane via the role mapping (see `docs/agent-roster-manifest.md` and `docs/delegation-router-policy.md`), does the work, and writes one `result` record per lane:

```
{
  "schema": "openclaw-frontier.blackboard-ledger.v1",
  "kind": "result",
  "agent": "<lane.role>",
  "taskId": "<goalId>.<laneName>",
  "ok": true,
  "summary": "<lane outcome, up to 1000 chars>",
  "artifacts": ["relative/path/to/receipt.md"]
}
```

After dispatch the harness polls the ledger every 200ms until either:

- a `result` exists for every dispatched taskId, or
- `--max-wait-ms` (default 300000 = 5 min) elapses, in which case missing lanes are marked PENDING in the synthesis trace and the trace's overall `ok` is false.

The harness synthesizes the final trace once polling returns, regardless of overall success. The trace is the canonical output and is always JSON.

## Mock mode

The CLI defaults to mock mode (`--mock-agents`) so a fresh clone runs end-to-end:

```bash
npm install --ignore-scripts
node bin/openclaw goal "ship a fix for X"
```

In mock mode the orchestrator plays every role, writes one synthesized `result` per lane, and short-circuits the polling budget to 5000ms. Use mock mode for:

- Smoke tests in CI (`verify-package.js` exercises this path).
- Quickstart walk-throughs.
- Iterating on the harness, schema, or lane plan without standing up live agents.

Mock mode is opt-in for `node scripts/orchestrate.js` (you must pass `--mock-agents`); it's opt-out for `openclaw goal "..."` (CLI default).

To require live agents, pass `--no-mock-agents` (CLI) or simply omit the flag for the underlying script.

## Coordination patterns

The default lane → role dispatch is 1:1 (one task-claim per lane). For more
complex coordination, lanes can declare a `pattern` field. Four patterns ship
in `lib/coordination/`:

| Pattern    | Use when                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| `fan-out`  | N independent tasks run in parallel; you need all of them to finish.     |
| `fan-in`   | A joiner consumes the outputs of N upstream tasks (often a prior fan-out). |
| `chain`    | Step N+1 strictly depends on step N's output; pipeline ordering matters. |
| `voting`   | A decision needs a cross-role quorum + threshold (e.g. 3-of-4 approve). |

Patterns sit ABOVE the blackboard + taskflow primitives. They emit `task-claim`
records and read back `result` records — they do not manage the FSM directly.
Each pattern module exports a single async function and is independently
testable (see `lib/coordination/test/*.test.js`).

### Lane shape with patterns

A lane that uses a pattern carries its task plan inline. The lane-level
`role` defaults to `orchestrator` for pattern lanes (the per-task roles are
specified inside the pattern payload). Examples:

#### fan-out

```json
{
  "name": "review-files",
  "pattern": "fan-out",
  "summary": "Review three files in parallel",
  "tasks": [
    { "id": "review-a", "role": "reviewer", "summary": "review file a" },
    { "id": "review-b", "role": "reviewer", "summary": "review file b" },
    { "id": "review-c", "role": "reviewer", "summary": "review file c" }
  ]
}
```

The harness writes one `task-claim` per task with id `<goalId>.<task.id>` and
waits until every task has a matching `result` record (or the lane budget
elapses). `ok` is true iff every task returned `ok: true`.

#### fan-in

```json
{
  "name": "synthesize",
  "pattern": "fan-in",
  "summary": "Merge upstream verdicts into one recommendation",
  "sourceTaskIds": [
    "goal-foo.review-a",
    "goal-foo.review-b",
    "goal-foo.review-c"
  ],
  "joiner": {
    "id": "synthesize",
    "role": "architect",
    "summary": "merge upstream verdicts"
  }
}
```

The coordinator does NOT dispatch the upstream tasks itself — it assumes a
prior lane (often a fan-out) already wrote them and waits for their results.
Once all upstream results are present, the joiner task-claim is written; its
`summary` lists the upstream taskIds so the joiner agent can fetch their
artifacts off the ledger.

#### chain

```json
{
  "name": "research-then-build",
  "pattern": "chain",
  "summary": "Research, draft a spec, then implement",
  "steps": [
    { "id": "research", "role": "researcher", "summary": "gather context" },
    { "id": "spec", "role": "architect", "summary": "draft a spec" },
    { "id": "build", "role": "builder", "summary": "implement against the spec" }
  ]
}
```

The harness dispatches step 1, waits for its result, then dispatches step 2
with the prior step's taskId embedded in the next step's summary. If any step
returns `ok: false` or times out, subsequent steps are NOT dispatched and the
lane records them as `skipped`.

#### voting

```json
{
  "name": "ship-release-vote",
  "pattern": "voting",
  "summary": "Cross-role approval to ship v0.6.0",
  "decision": "Approve release of v0.6.0?",
  "voters": [
    { "id": "sec", "role": "security_sentinel" },
    { "id": "rev", "role": "reviewer" },
    { "id": "arch", "role": "architect" },
    { "id": "build", "role": "builder" }
  ],
  "quorum": 3,
  "threshold": 0.667
}
```

Each voter receives the same `decision` prompt in their own role lane and
writes a `result` record. The coordinator counts approve / reject votes,
applies `quorum` (minimum voters needed) and `threshold` (fraction of cast
votes required to approve), and returns the verdict. `ok` is `decided &&
verdict === 'approve'`.

### Mixing pattern and simple lanes

A goal can have both pattern lanes and simple (no-pattern) lanes; the harness
runs the pattern lanes first, then dispatches the simple lanes via the
existing 1:1 path. The final `lanes` array in the trace preserves the goal
authoring order. Existing goals without any `pattern` field continue to work
identically.

### Mock mode for patterns

The CLI defaults to `--mock-agents`, which synthesizes one `result` per
pattern-internal task / step / voter so the loop closes without a live bus.
The CLI's `--pattern <name>` flag pairs the default-prompt path with a small
production smoke-test lane plan that exercises each pattern:

```bash
node bin/openclaw goal "test fan-out" --mock-agents --pattern fan-out
node bin/openclaw goal "test chain"   --mock-agents --pattern chain
node bin/openclaw goal "test voting"  --mock-agents --pattern voting
node bin/openclaw goal "test fan-in"  --mock-agents --pattern fan-in
```

Each emits a trace where the pattern-driven lane is marked `[done]` with a
one-line summary (e.g. `fan-out: 3 ok / 0 fail / 0 timed-out (of 3)`). The
full internal pattern trace is available under
`trace.patternLanes[].patternTrace` when the harness is invoked with
`--json`.

## Goal templates

Named JSON templates under `lib/goal-templates/templates/` let an operator spin up a realistic multi-lane goal with one flag. Five templates ship in v0.7:

| Template          | Shape                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `ship-release`    | chain (scan -> verify -> tag -> release-notes) + voting (3-of-3 approve) + sentinel sign-off           |
| `fix-bug`         | chain (reproduce -> root-cause -> patch -> test -> review)                                             |
| `build-feature`   | architect spec -> fan-out design review (architect+reviewer+security) -> builder -> verifier -> ship   |
| `audit-repo`      | fan-out scans (current+history+deps+security) -> fan-in scribe report -> reviewer sign-off             |
| `daily-summary`   | chain (read-blackboard -> categorize -> write-summary)                                                 |

Usage:

```bash
openclaw goal --list-templates                       # show available templates
openclaw goal --template ship-release "v0.7.0"        # instantiate
openclaw goal --template build-feature "OAuth login"  # instantiate
```

The `--template` flag is mutually exclusive with `--file`. Each template carries a `titleTemplate` and uses two substitution tokens:

- `${context}` — the string the operator passes after the template name
- `${goalId}` — the generated goal id (filled in after the id is chosen, so fan-in lanes can reference upstream task ids without the operator knowing the random suffix)

Templates are pure JSON conforming to `openclaw-frontier.goal.v1`; operators with a one-off shape should still use `--file <path>`.

## Cross-session goal state (`--resume`)

Every non-`--dry-run` goal invocation writes its state to `<blackboard-parent>/.openclaw/goals/<goal_id>.json`. The file tracks:

- `goalId`, `title`, `status` (`active|done|failed|aborted`), `createdAt`, `updatedAt`, `completedAt`
- The original `goal` record (so resume doesn't need the prompt or template again)
- `dispatchedClaims`, `patternLanes`, `receivedResults`, `synthesis`
- `cost` — see "Per-goal cost tracking" below
- `errors` — any runtime errors encountered during the run

CLI surface:

```bash
openclaw goal --list                       # last 20 persisted goals (most recent first)
openclaw goal --list --all                 # show every goal in the directory
openclaw goal --show <goal_id>             # print state summary
openclaw goal --resume <goal_id>           # re-attach to a partial goal
openclaw goal --no-persist "test goal"     # opt out of state file (useful for one-shot probes)
openclaw goal --goals-dir <path> ...       # override the state directory
```

Resume semantics:

1. Re-read the state file. If `status` is already `done|failed|aborted`, the resume is a no-op and the CLI prints a synthesized trace built from the persisted state (exit 0 on `done`, 1 otherwise).
2. Otherwise, re-read the blackboard. For every lane whose `task-claim` is missing, dispatch it. For every lane whose claim exists but has no `result`, continue polling.
3. Update the state file as new results land. Write the final synthesis on completion.

Operators don't need to remember the goal id — `--list` shows it in the first column.

## Per-goal cost tracking

When a live agent (`openclaw-agent`) processes a task and the model backend returns a `usage` block, the agent writes a sibling `fact` record with subject `usage:<taskId>` carrying `{ schema: 'openclaw-frontier.agent-usage.v1', model, usage }`. The orchestrator reads those facts during synthesis and produces a per-goal USD estimate using `lib/cost-table.json`.

The default cost table covers the three supported Claude model surfaces (snapshot 2026-05):

| Model                              | $ / MTok input | $ / MTok output | $ / MTok cache write | $ / MTok cache read |
| ---------------------------------- | --------------:| ---------------:| --------------------:| -------------------:|
| `claude-opus-4-7`                  |  15.00         |  75.00          |  18.75               |  1.50               |
| `claude-sonnet-4-6`                |   3.00         |  15.00          |   3.75               |  0.30               |
| `claude-haiku-4-5-20251001`        |   0.80         |   4.00          |   1.00               |  0.08               |

This is an ESTIMATE only. The table is a snapshot and will go stale as provider pricing changes. Operators who need authoritative billing should consult their provider's billing console. The estimate is intended for capacity planning and goal-cost visibility.

Override via environment variable:

```bash
export OPENCLAW_COST_TABLE=/path/to/your-cost-table.json
```

A custom table must follow the same shape (`{ models: { <id>: { input, output, cache_write, cache_read } }, aliases?, fallback? }`). Aliases let one logical model id (e.g. `claude-opus-4-7[1m]`) map onto a canonical entry. A `fallback` entry is used when a model id is unknown — the bundled fallback equals the sonnet rate.

Read the estimate via:

```bash
openclaw goal --show <goal_id>     # includes `cost estimate: $0.xxxxx (N calls)`
openclaw recap --cost              # cost column added; per-goal subtotals in narrative
```

## Failure recovery semantics

Each lane can declare a `failure_mode` (alias: `failureMode`) describing how a non-OK result should be handled. Values:

| Value          | Behavior                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `abort` (default) | First failed lane fails the whole goal. Subsequent unrun lanes stay pending. trace.aborted=true. |
| `continue`     | Record the failure, mark the lane red, but proceed to other lanes and synthesis.                |
| `retry-N`      | Re-dispatch the lane under a new taskId suffix (`<goalId>.<lane>.retry-K`) up to N times, with exponential backoff (100ms, 200ms, 400ms, ..., capped at 2s). The most recent retry decides the lane verdict. Previous results stay on the ledger for audit. |

Example fragment in a goal file:

```json
{
  "lanes": [
    {
      "name": "implementation",
      "role": "builder",
      "summary": "...",
      "failure_mode": "retry-2"
    },
    {
      "name": "docs",
      "role": "scribe",
      "summary": "...",
      "failure_mode": "continue"
    },
    {
      "name": "sentinel-gate",
      "role": "sentinel",
      "summary": "...",
      "failure_mode": "abort"
    }
  ]
}
```

The synthesis trace exposes the per-lane verdict, the per-lane status (`done|failed|pending`), and the top-level `aborted` flag so callers can distinguish "we aborted on first failure" from "we kept going but ended with a red lane".

Pattern lanes (`fan-out`, `chain`, `voting`, `fan-in`) own their own failure semantics — see `lib/coordination/*` for details. `failure_mode` only applies to simple (1:1) lanes.

## Observable progress

`openclaw goal` prints one-line status updates to **stderr** as each lane changes state:

```
goal-start goal-foo-1234: Ship release v0.7.0
dispatching implementation (builder)
dispatching documentation (docs)
received implementation ok=true
received documentation ok=true
goal-done goal-foo-1234 ok=true status=done cost=$0.006936 (3 model calls)
```

Flags:

| Flag         | Behavior                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| `--quiet`    | Suppress all progress lines. Stdout (the trace JSON) is unchanged.                         |
| `--verbose`  | Add timestamps, full task ids, byte counts, retry attempt numbers, and minor lifecycle events. |
| (default)    | One readable line per lane state transition.                                              |

The progress stream is a SUBSET of what `openclaw watch` shows — pretty-printed and opinionated; for a full raw-records tail use `openclaw watch`. Stdout always carries the canonical synthesis (text by default, JSON with `--json`).

When wiring `openclaw goal` into CI you typically want `--quiet --json` so the structured trace is the only output the pipeline parses.

## Live-path integration test

The package ships an end-to-end live-path test at `test/integration/goal-live-path.test.js` (also wired into `npm run verify` as the `goal-live-path-integration` check). The test:

1. Starts an in-process mock model server on a random localhost port using `node:http` (no `express`, no `fastify`, no real network).
2. Sets up a fresh blackboard ledger in a temp directory.
3. Spawns one `bin/openclaw-agent` process per role declared by the goal fixture, each pointed at the mock server with `--max-tasks 1`.
4. Spawns `bin/openclaw goal --file <fixture> --blackboard <temp> --no-mock-agents`.
5. Asserts that every lane receives a result on the ledger, the trace's `ok` is true, the goal-state file shows `status=done`, the cost estimate is positive (and bounded — protects against unit errors), and no `decision: blocked` records were emitted.

The test runs in under two seconds on a typical workstation and uses no real network calls. It exercises the **live dispatch path** end-to-end; it does NOT use `--mock-agents`.

If you are adding a new agent runtime (e.g. a Codex-backed agent or a Cursor-backed agent), this is the test to mirror: replace the spawn of `openclaw-agent` with your own daemon and let the existing assertions pin the contract.

The test reuses the `forRole` routing field on `task-claim` records. The orchestrator writes claims with `agent: 'orchestrator'` and `forRole: <lane.role>`; the agent filters on `forRole` (falling back to `agent` for legacy claims written without the field).

## Watching execution

`openclaw watch` tails the blackboard ledger in real time. It is useful when
multiple agents are running concurrently and you want to see the dispatch /
result flow as it happens.

```bash
openclaw watch
openclaw watch --blackboard ./blackboard.jsonl --no-color
openclaw watch --filter result --agent reviewer
openclaw watch --since 5m
```

Flags:

| Flag                | Default                  | Behavior                                       |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `--blackboard <p>`  | `./blackboard.jsonl`     | path to the blackboard ledger JSONL            |
| `--filter <kind>`   | (none)                   | only show records of this kind                 |
| `--agent <name>`    | (none)                   | only show records emitted by this agent        |
| `--since <when>`    | (none)                   | ISO timestamp or relative (`5m`, `1h`, `30s`)  |
| `--no-color`        | color enabled in a TTY   | disable ANSI color (use when piping)           |
| `--json`            | text                     | emit raw JSON records, one per line            |

Example output:

```
13:42:17  task-claim    orchestrator  goal-foo.review-a         "[goal-foo][fan-out] review file a"
13:42:17  task-claim    orchestrator  goal-foo.review-b         "[goal-foo][fan-out] review file b"
13:42:18  path-claim    builder       goal-foo.review-a         src/router.js (write)
13:42:22  result        reviewer      goal-foo.review-a         ok lgtm
13:42:23  path-release  builder       goal-foo.review-a         src/router.js
13:42:24  result        reviewer      goal-foo.review-b         FAIL stale comment on line 42
```

If the blackboard file does not exist yet, `watch` polls every 500ms until it
appears. Use Ctrl-C to stop.

The watch command READS the ledger; it never writes. It is safe to run
concurrently with agents that are appending records — watch is a passive
observer.

## How to write a custom autonomous loop

An autonomous loop is a recurring orchestrated check that detects drift, regression, or new state and proposes a remediation PR or issue. The shipped instance is `skill-eval-drift-detection-with-auto-PR-proposal`, defined in `.github/workflows/autonomous-loops.yml`.

The template:

```yaml
name: Autonomous loop — <one-line description>

on:
  schedule:
    - cron: "<cron>"          # weekly is the safe default
  workflow_dispatch:
    inputs:
      <knob>:
        description: "<what it controls>"
        required: false
        default: "<sensible default>"

permissions:
  contents: write    # PR creation
  issues: write      # tracking issue
  pull-requests: write

concurrency:
  group: autonomous-<loop-name>
  cancel-in-progress: false

jobs:
  loop:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm install --ignore-scripts
      - name: Detect drift / regression / state change
        run: <produce a JSON summary>
      - name: Open draft PR if remediation needed
        if: <regression detected>
        env:
          GH_TOKEN: ${{ github.token }}
        run: <gh pr create --draft>
      - name: Open or update tracking issue
        if: <regression detected>
        env:
          GH_TOKEN: ${{ github.token }}
        run: <gh issue create/comment>
```

Rules for an autonomous loop:

1. **One open issue per loop per ISO date + variant.** Same-day reruns update; new days open new issues. Use `gh issue list --search` for dedup.
2. **PR is always draft.** A human reviews and presses Ready for Review or closes.
3. **No silent writes outside the loop's branch.** Use a branch name like `eval-drift/<date>`; never push to main.
4. **All knobs are workflow_dispatch inputs or repo variables.** Never bake values into the YAML.
5. **Auth via `secrets.ANTHROPIC_OAUTH_TOKEN` first, `secrets.ANTHROPIC_API_KEY` second.** OAuth charges the user's Pro/Max subscription. Never log either secret.

### The shipped instances

The stack ships five autonomous loops. Each is a separate workflow file under `.github/workflows/`; none collide on schedule or concurrency group.

#### 1. Eval-drift detection (Monday 10:00 UTC)

`.github/workflows/autonomous-loops.yml`:

1. Runs `npm run eval:live --model $CURRENT_MODEL` and `--model $BASELINE_MODEL` against the Modern Skills eval suite.
2. Computes the per-skill assertion pass rate for both runs.
3. For every skill where the current model is more than `$DRIFT_THRESHOLD_PCT` (default 10) percentage points behind the baseline, writes a `release-gate/eval-drift/<date>-<skill>.json` artifact.
4. Commits the artifacts on branch `eval-drift/<date>`, opens a draft PR, and opens or updates a tracking issue with label `eval-drift`.

`EVAL_BASELINE_MODEL` is a repository variable; the default if unset is `claude-haiku-4-5-20251001`. Override at dispatch time via the `baseline_model` input.

#### 2. Dependency vulnerability scan (daily 06:00 UTC)

`.github/workflows/dependency-vulnerability-scan.yml`:

1. Runs `npm install --package-lock-only` and then `npm audit --json`.
2. Filters findings to severity `high` and `critical` (override via the `min_severity` dispatch input).
3. Opens or updates an issue labeled `dependency-vulnerability` with the affected packages, severities, advisory links, and suggested fix versions. Dedup: one open issue per ISO date + highest severity.
4. When a scan is clean, comments "Resolved in commit \<sha\>" on every previously open issue and closes it.
5. If `npm audit` itself fails (network, malformed lockfile), opens a separate `infra-degraded` issue instead of a false-positive vulnerability report.

#### 3. Performance baseline drift (Monday 11:00 UTC)

`.github/workflows/performance-baseline-drift.yml`:

1. Runs `scripts/eval-frontier-orchestration-scale.js` and `scripts/eval-blackboard-contention.js`, capturing wall-clock and assertion score for each.
2. Reads the previous green baseline from `release-gate/reports/perf-baseline.json` on branch `release-gate/baselines` (the loop maintains this branch).
3. If wall-clock regressed by more than `time_threshold_pct` (default 20%) OR score dropped by more than `score_threshold_pct` (default 15%), opens or updates a `performance-regression` issue. Dedup: one open issue per ISO date.
4. If the run is green, force-pushes the new baseline onto `release-gate/baselines` — no PR, no diff against main.

#### 4. Documentation staleness (Friday 09:00 UTC)

`.github/workflows/documentation-staleness.yml`:

1. For each `docs/*.md`, checks `git log -1 --format=%cs` against the `stale_days` threshold (default 180).
2. For each stale doc, looks for non-doc tracked files containing the same root tokens (heuristic) modified inside the same window. A doc only flags if its presumed source has moved while the doc itself stayed put.
3. For each `skills/*/SKILL.md`, flags any SKILL.md untouched in the same window, regardless of source movement.
4. Opens or updates a `documentation-staleness` issue summarizing both lists. Dedup: one open issue per calendar quarter (e.g. `2026-Q2`).

#### 5. Prompt tuning (1st of month 10:00 UTC)

`.github/workflows/prompt-tuning.yml`:

1. Picks one skill per run. Cycling logic: read `release-gate/reports/prompt-tuning-results-<date>-<skill>.json` fact records and select the skill whose most recent tuning attempt is oldest (or which has never been attempted). Override with the `skill` dispatch input.
2. Runs the eval suite restricted to that skill against the current SKILL.md.
3. Generates a variant SKILL.md by feeding the current file plus `release-gate/lib/prompt-tuning-template.md` through the eval runner's model backend.
4. Runs the eval suite restricted to that skill against the variant (then immediately restores the original on disk).
5. If pass-rate improves by more than `improvement_threshold_pct` (default 10 pp), opens a draft PR labeled `prompt-tuning-candidate` with the variant diff and the eval scores. Otherwise writes a fact record and exits clean.
6. If the model backend is unavailable or an eval crashes, opens an `infra-degraded` issue.

Auth for the prompt-tuning loop follows the same `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` → `OPENCLAW_EVAL_*` fallback chain as the scheduled-evals workflow.

## How to extend the CLI

The CLI is a single Node file (`bin/openclaw`) with a flat subcommand dispatch. To add a subcommand:

1. Add a `cmdYourCommand(positional, flags)` function in the file.
2. Add a `case 'your-command': return cmdYourCommand(positional, flags);` in the `main()` switch.
3. Add a usage line to `HELP_TEXT`.
4. If your command needs a new flag, add a parse branch to `parseGlobal()`.

Guidelines:

- All new subcommands must support `--json` for machine-readable output and a default human-readable rendering.
- All new subcommands must validate inputs through `toSimpleAgentId` / `toSimpleTaskId` if they emit ledger records.
- Long-running subcommands (anything that could exceed a few seconds without output) should print progress to stderr, not stdout. Stdout is always the structured trace/result.
- Subcommands must exit 0 on success, 1 on partial failure (e.g. a goal with a failed lane), 2 on bad arguments.
- No new runtime dependencies. Vanilla Node and the existing optional `nats`.

## Failure modes

### Lane stuck (no result before max-wait-ms)

Symptom: the trace shows `status: "pending"` for one or more lanes after `--max-wait-ms` elapses. Overall `ok` is false.

Diagnosis:

- The role's agent did not observe the claim. Confirm the agent is subscribed to the blackboard ledger or signed bus.
- The agent observed but failed to write a result. Check the agent's local log for crash / panic.
- The blackboard ledger path is wrong. Confirm `--blackboard` matches what the agent is reading.

Recovery: rerun in `--mock-agents` to verify the harness itself is healthy, then triage the live agent separately.

### Agent disagrees with the orchestrator

If a live agent picks up a claim and writes a `result` with `ok: false`, the trace marks that lane as `failed` and the overall `ok` is false. The agent's failure summary is preserved in the trace.

The orchestrator does NOT override the lane verdict. To remediate, fix the underlying issue, rerun with a new goal id (or the same id — the ledger is append-only and the most recent result wins per taskId).

### No live agents to dispatch to

Use `--mock-agents` (CLI default for the prompt path) or `--dry-run` (writes nothing to the ledger; emits a simulated trace describing what would have happened).

Run `node bin/openclaw goal "test" --dry-run --json` to verify the lane plan without dispatching.

### Goal validation error

`GoalValidationError` from the harness means the goal record does not match `openclaw-frontier.goal.v1`. The error message identifies the offending field. The CLI exits 2; no ledger writes occur.

Common causes:

- `lanes` is missing or empty
- `lanes[i].role` contains characters outside `[A-Za-z0-9_-]`
- `lanes[i].name` is a duplicate within the same goal

### Blackboard lock timeout

The blackboard ledger uses a directory-based file lock with a 10 second default timeout. If the harness errors with `ledger lock timeout`, another writer is holding the lock for too long. Diagnose with `ls <blackboard>.lock/` to see which pid is the lock owner. Stale locks (older than 30 seconds) are auto-cleared.

## Trust model

Agents are NOT trusted. Every result record carries:

1. The agent id that wrote it (cross-checked against the blackboard public-safety scan).
2. A `summary` string capped at 1000 chars (no embedded secrets allowed).
3. Up to a bounded list of relative `artifacts` paths (normalized; absolute and home paths are rejected).

The verifier (separate, run as part of `verify-package.js` or the autonomous-loops workflow) re-reads receipt files and re-runs smoke commands to confirm the agent told the truth. The orchestrator does not assert that a lane's `ok: true` means the work is correct — only that the agent claimed it did.

Specifically:

- The orchestrator does not execute agent prompts in-process, so it cannot witness model outputs directly. Every artifact must be on disk and hashable.
- The signed-bus envelope (see `src/signed-bus/lib/envelope.js`) provides Ed25519 detached signatures over canonical JSON for any cross-machine bus traffic. When an agent runs locally and writes directly to the ledger, the signature is implicit (the ledger lock + private-content scan is the trust boundary).
- All emitted records pass the public-safety scan in `src/blackboard/lib/ledger.js`: no home paths, no API tokens, no Tailscale IPs, no SSH private keys, no Telegram-bot-token-shaped values.

Operators escalate to manual review when:

- Any lane returns `ok: false` and the failure summary mentions a security-impacting class (credential, network, destructive change).
- Any artifact path points to a directory that requires Sentinel approval (see `docs/sentinel-release-gate.md`).
- The trace's `red` array is non-empty after the full polling budget.

## Verification

The harness is exercised by:

- `node scripts/verify-package.js` runs:
  - the existing `examples/goal-loop-demo/run-goal-demo.js` synthetic smoke (no agents),
  - the new `test/integration/goal-live-path.test.js` end-to-end live-path test (mock model server + spawned agent processes + orchestrator) — wired in as the `goal-live-path-integration` check.
- `node scripts/orchestrate.js --goal-file examples/goal-loop-demo/goal-fixture.json --mock-agents` returns exit 0 with a synthesized trace.
- `node bin/openclaw goal "test"` returns exit 0 with all five default lanes GREEN.
- `node bin/openclaw goal --template ship-release "ship v0.7.0"` instantiates the templated multi-pattern goal and writes a state file at `.openclaw/goals/<id>.json`.

## Pointers

- Goal-loop quickstart: `examples/goal-loop-demo/`
- Production goal fixture: `examples/goal-loop-demo/goal-fixture.json`
- Goal templates: `lib/goal-templates/templates/*.json`
- Cost table: `lib/cost-table.json` (override via `OPENCLAW_COST_TABLE`)
- Goal-state persistence: `src/orchestrator/lib/goal-state.js`
- Live-path integration test: `test/integration/goal-live-path.test.js`
- TaskFlow runtime: `src/taskflow/lib/taskflow.js`
- Blackboard ledger: `src/blackboard/lib/ledger.js`
- Signed-bus envelopes: `src/signed-bus/lib/envelope.js`
- Goal system specification: `docs/goal-system.md`
- Delegation router policy: `docs/delegation-router-policy.md`
- Agent roster manifest: `docs/agent-roster-manifest.md`
- Skill eval telemetry: `docs/skill-eval-telemetry.md`
- Sentinel release gate: `docs/sentinel-release-gate.md`
