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

### The shipped instance: eval-drift detection

`.github/workflows/autonomous-loops.yml` runs every Monday at 10:00 UTC:

1. Runs `npm run eval:live --model $CURRENT_MODEL` and `--model $BASELINE_MODEL` against the Modern Skills eval suite.
2. Computes the per-skill assertion pass rate for both runs.
3. For every skill where the current model is more than `$DRIFT_THRESHOLD_PCT` (default 10) percentage points behind the baseline, writes a `release-gate/eval-drift/<date>-<skill>.json` artifact.
4. Commits the artifacts on branch `eval-drift/<date>`, opens a draft PR, and opens or updates a tracking issue with label `eval-drift`.

`EVAL_BASELINE_MODEL` is a repository variable; the default if unset is `claude-haiku-4-5-20251001`. Override at dispatch time via the `baseline_model` input.

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

- `node scripts/verify-package.js` includes the existing examples/goal-loop-demo/run-goal-demo.js smoke run. (The orchestrate harness itself is not yet wired into verify — see follow-ups.)
- `node scripts/orchestrate.js --goal-file examples/goal-loop-demo/goal-fixture.json --mock-agents` returns exit 0 with a synthesized trace.
- `node bin/openclaw goal "test"` returns exit 0 with all five default lanes GREEN.

## Pointers

- Goal-loop quickstart: `examples/goal-loop-demo/`
- Production goal fixture: `examples/goal-loop-demo/goal-fixture.json`
- TaskFlow runtime: `src/taskflow/lib/taskflow.js`
- Blackboard ledger: `src/blackboard/lib/ledger.js`
- Signed-bus envelopes: `src/signed-bus/lib/envelope.js`
- Goal system specification: `docs/goal-system.md`
- Delegation router policy: `docs/delegation-router-policy.md`
- Agent roster manifest: `docs/agent-roster-manifest.md`
- Skill eval telemetry: `docs/skill-eval-telemetry.md`
- Sentinel release gate: `docs/sentinel-release-gate.md`
