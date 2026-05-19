# Changelog

All notable public-package changes should be recorded here. This changelog is for the operator-safe OpenClaw Frontier Stack package only; it must not reference private runtimes, personal context, raw logs, credentials, private hosts, or external announcements.

## 2026-05-19 — v0.8.0 — Hermes-port system layer, ticketing v2, goal v3, N-API FFI, graded release-gate, squad-agent integration

Status: published.

Largest single release. Lands the Hermes-port system layer (cron, doctor, supply-chain advisory, webhook, gateway-style event-hook lifecycle, subagent fan-out), ticketing v2 (templates, multi-assignee, watchers, attachments, SLA pause, goal binding, bulk transitions), goal v3 (failure-recovery policies, streaming progress, cancellation tokens, sub-goals, `--gantt`, `--diff`, cost-table refresh), N-API FFI binding for the Rust envelope crate with pure-JS fallback, a graded release-gate with mutation testing + live-model skill eval + composite letter grade, a squad-agent integration installer that bridges OFS skills + bin into Neo/Yoru/Rei runtimes, bundles + per-release notes renderer, and 19 new skills (skill catalog 68 → 87). All wired through the existing signed-bus / blackboard / taskflow / 11-role-contract substrate.

### Added — Hermes-port system layer

Six standalone capabilities ported from the May 2026 `NousResearch/hermes-agent` audit (`docs/hermes-agent-audit.md`):

- **`bin/openclaw-cron`** — file-locked cron scheduler. Reads `cron/jobs.json`, ticks every 60 s, drops `task-claim` envelopes on the blackboard for due jobs. Inline cron parser handles `* * * * *`, lists, ranges, `*/N` steps. Operator guide at `docs/cron-scheduler.md`.
- **`openclaw doctor`** — runtime health check across blackboard reachability, signed-bus key presence, role-contract availability, model-backend configuration (without leaking values), Node version, verifier-latest, and ticket store. `--json`, `--no-network`, `--blackboard <path>` flags. Operator guide at `docs/doctor.md`.
- **`bin/openclaw-webhook`** — HMAC-auth'd inbound webhook daemon. Validates signatures, transforms GitHub events (PR, issue, push) + generic JSON, drops `task-claim` envelopes on the blackboard. Bound to `127.0.0.1` by default; no third-party server framework. Operator guide at `docs/webhook-subscriptions.md`.
- **Supply-chain advisory** — `npm run verify:supply-chain` runs `npm audit --json` plus optional `osv-scanner --lockfile=package-lock.json`, applies a `release-gate/supply-chain-allowlist.json` with 90-day-max entries, emits a JSON report, exits non-zero on un-allowlisted HIGH/CRITICAL findings. Daily `.github/workflows/supply-chain-advisory.yml` opens an issue when findings appear. Operator guide at `docs/supply-chain-advisory.md`.
- **Gateway-style event-hook lifecycle** — `hooks/hooks.json` schema v2 adds named events: `goal:start`, `goal:end`, `lane:dispatch`, `lane:result`, `release-gate:propose`, `release-gate:approve`, `release-gate:reject`. Hooks are any executable that reads a JSON event from stdin and optionally writes a `{decision, reason}` or `{context}` JSON to stdout. Consent allowlist at `release-gate/hook-allowlist.json` keyed by executable SHA-256. New `openclaw hook list / allow / deny` subcommands. Wired into `src/orchestrator/lib/goal-loop.js`. Examples at `hooks/EXAMPLES.md`.
- **Subagent fan-out helper** — `lib/coordination/subagent.js` spawns N parallel child agents (out-of-process or `worker_threads`) with custom role + restricted toolset + restricted blackboard-write scope. Children's intermediate facts stay in a child-only blackboard slice; only the result record propagates to the parent.

### Added — ticketing v2 (`src/tickets/`)

Substantial extension to the v0.7.0 ticketing FSM. Six new capabilities, all back-compatible with v1 ticket records:

- **Templates** at `src/tickets/templates/{bug-report,feature-request,incident-postmortem,customer-request,engineering-debt}.json`. CLI: `openclaw ticket create --template <name>` pre-populates the ticket.
- **Multi-assignee** — `assignees: string[]` field plus derived primary `assignedTo`. `openclaw ticket assign <id> --add <name> --remove <name>`.
- **Watchers** — `watchers: string[]` receive notifications on state changes but don't own. `openclaw ticket watch / unwatch <id>`.
- **Attachments** — `attachments: { path, addedBy, addedAt, sha256 }[]`. The ticket store never copies the file; it just records the SHA-256 + relative path. `openclaw ticket attach <id> <path>`.
- **SLA pause windows** — `slaPauseWindows: { from, to, reason }[]`. SLA computation subtracts paused durations. `openclaw ticket sla-pause / sla-resume <id>`. The hourly `.github/workflows/ticket-sla-escalation.yml` respects the pause windows.
- **Ticket→goal binding** — `goalId` field. `openclaw ticket bind --goal <goal-id>`. The `reconcileGoalCompletion(goalId)` API auto-transitions bound tickets when the goal finishes; failed goals flag bound tickets as `blocked` with reason `goal-failed`.
- **Bulk transitions** — `openclaw ticket bulk-move --status in-progress --to review --assigned-to <name>` operates on a filter. FSM rules still apply per ticket; failures surface as a list.

### Added — goal v3 (`bin/openclaw goal`, `src/orchestrator/lib/`)

The goal-loop refinement that turned v0.7.0's mock-mode skeleton into a production scheduler:

- **Failure-recovery policies** — per-lane `failurePolicy: { onFailure: 'abort'|'continue'|'retry'|'fallback', retries, fallbackRole }`. Default `continue` keeps v0.7.0 behavior; the new policies enable real recovery flows. Every failed lane writes a `lane-recovery` blackboard record describing what failed + the recovery action taken.
- **Streaming progress** — `--progress-file <path>` writes JSONL events (`goal:start`, `lane:dispatch`, `lane:result`, `lane:retry`, `goal:end`) to a configurable sink. Existing `--quiet` / `--verbose` flags control stderr verbosity.
- **Cancellation tokens** — `openclaw goal --cancel <goal-id>` writes a `cancel-request` record; the running goal-loop polls between lanes and aborts cleanly (writes `goal:cancelled` + releases path-claims).
- **Sub-goals** — `subGoals: [{ id, template, context }]` in the goal spec. Sub-goals run after the parent's main lanes; results bind to `subGoalResults` on the parent. Sub-goal state files live under `<goalsDir>/sub/<parent-id>/<sub-id>.json`.
- **`--gantt`** — `openclaw goal --gantt <id>` renders an ASCII gantt chart of lane execution windows. `--svg <file>` writes SVG. `--no-color` strips ANSI.
- **`--diff`** — `openclaw goal --diff <id-a> <id-b>` reports structural delta between two goal-state files (lanes added/removed, role changes, status differences).
- **Cost-table auto-refresh** — `lib/cost/refresh.js` recomputes `lib/cost-table.json` from a pluggable pricing source; monthly `.github/workflows/cost-table-refresh.yml` opens a PR when rates change.

Five new tests added (`src/orchestrator/test/goal-{failure-recovery,cancellation,subgoals,gantt,diff}.test.js`, 19 cases total) wired into the package verifier.

### Added — N-API FFI binding (`crates/openclaw-envelope-node/`)

Rust crate that wraps `openclaw-envelope` with `napi-rs` bindings exposing `sign`, `verify`, `canonicalize`, `stable` to Node. Pure-JS fallback at `src/signed-bus/lib/envelope-loader.js` — consumers go through the loader and get the native binding when available, the JS implementation when not. `src/signed-bus/test/envelope-parity.test.js` runs the 15-entry canonical-corpus through both paths and asserts byte-equality. The loader path is the new contract; four consumers were re-routed (`signed-bus-client.js`, both signed-bus tests, `eval-frontier-orchestration-scale.js`). The native binary is not a build dependency — `cargo build` is opt-in, the parity test skips native cleanly when the binary is absent.

### Added — graded release-gate (`lib/grading/`, `scripts/grade.js`)

The release-gate that answers "does this actually work?" with a number instead of a vibe. Eight scored categories aggregated into a weighted composite letter grade:

- **`release-gate-strictness`** (weight 15) — **mutation testing.** Seventeen named mutations apply a known bug (delete a SKILL.md, corrupt a manifest, inject a fake email, plant a nested duplicate, set a fake version, strip a shebang, etc.), run the verifier, capture pass/fail, then revert atomically. Score = caught / total. This is the killer category — it makes "is this theater?" a math question.
- **`skill-eval-live`** (weight 25) — tier-3 live model evaluation. Calls Anthropic via OAuth (or any OAuth-first provider) with every skill's eval cases, scores outputs against typed assertions (`contains`, `not-contains`, `length-at-least`), aggregates pass rate. 8-concurrent calls, exponential backoff on 429/5xx, 30-day cache keyed by `(skillId, caseId, modelName, promptHash)`.
- **`skill-triggering-accuracy`** (weight 10) — does each skill's `description` make a model invoke it correctly? Forty-two hand-authored trigger cases distributed across clear-match (40%), oblique-match (31%), no-match (14%), ambiguous (14%).
- **`coordination-correctness`** (weight 15) — runs each coordinator (fan-out, fan-in, chain, voting, subagent) through a mock goal and asserts shape + ordering + error propagation.
- **`goal-loop-reliability`** (weight 15) — N=10 mock goal-loop runs, success rate + latency p50/p95.
- **`surface-integrity`** (weight 10) — re-uses the existing public-surface harness output as a finding count.
- **`hermes-parity`** (weight 5) — % of HIGH-priority Hermes audit rows that map to capabilities now shipped.
- **`docs-freshness`** (weight 5) — stale-doc count by 180-day window.
- **`public-safety`** — hard gate. Score 0 from any private-content scanner hit caps the composite at 50, regardless of other categories.

Composite formula in `lib/grading/composite.js`. Letter bands: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60. Scorecards rendered to `release-gate/scorecards/grade-vX.Y.Z.md` (git-tracked, per-release). GitHub workflow at `.github/workflows/grade.yml` runs on tag push, uploads scorecard as a release asset, opens an issue if composite drops below B. Operator guide at `docs/grading.md`. `npm run grade` for full run; `npm run grade:dry` skips tier-3 + mutation for fast iteration.

### Added — squad-agent integration installer (`integration/neo/`)

Bridges the OFS surface into Adam's squad agents (Neo on BEEF, Yoru on MBP, Rei on CONSTRUCT — same installer with `--neo-home` / `--yoru-home` / `--rei-home`). `npm run install:neo` is idempotent and reversible. Operations:

- **Skill bridge** — one symlink (NTFS junction on Windows, no admin required) per OFS skill into `<agent-home>/SKILLS/ofs/<skill-id>`. The squad agents' existing `skill-manage` walks `SKILL_ROOT` recursively and surfaces all 87 OFS skills. On junction failure (cross-volume, network share, restrictive policy) the installer falls back to recursive file-copy with the reason logged.
- **Bin bridge** — `<agent-home>/bin/ofs-path.sh` and `ofs-path.ps1` PATH shims that prepend OFS `bin/` so `openclaw doctor`, `openclaw ticket`, etc. resolve from any squad-agent session.
- **Plugin manifest** — durable `<agent-home>/openclaw-plugins.json` declaring OFS as an installed plugin with skills-path + bin-path + version.
- **Bus identity** — copies the squad agent's existing `<agent-home>/keys/ed25519.pub` to `release-gate/known-pubkeys/<label>.pub`, with a private-key safety check rejecting anything matching `private` in the first 256 bytes. If the agent has no pubkey, the installer warns and continues (skill discovery still works).

`--uninstall` removes every artifact added by install. Twelve integration tests pass on Windows; cross-host tested via dry-run against real `<neo-home>`. Operator guide at `integration/neo/README.md`; cross-host doc at `docs/integration-yoru-rei-neo.md`.

### Added — bundles + per-release notes renderer

- **`bundles.json`** — curated skill collections (`marketing-core`, `engineering-core`, `operator-core`, `agent-substrate`) so plugin hosts can install a slim subset. Metadata-only; skills stay in-repo. `openclaw bundles list / show / install <name>`. Operator guide at `docs/bundles.md`.
- **`scripts/render-release-notes.js`** — generates per-release notes from CHANGELOG + git history + skill-catalog delta. Sections: header, summary, stats (commits + insertions + files + new-skills), highlights, migration notes, full-changelog link. Tested end-to-end against real git history; `release-gate/release-notes/v0.7.0.md` is the validation artifact. Scribe contract extended at `agents/scribe/CONTRACT.md` to document when scribe calls the renderer.

### Added — skill catalog (68 → 87)

**Twelve engineering skills** (engineering total 28 → 37): `runbook-writing`, `change-management-policy`, `slo-design`, `query-performance-tuning`, `observability-pillars-integration`, `service-ownership-boundaries`, `capacity-planning`, `data-classification-and-handling`, `secrets-management`* `*` `*` `*` — the four from v0.7.0 wave were already shipped; v0.8.0 adds the remaining eight listed first.

**Ten marketing + AI-creative skills** (Modern Skills 37 → 47): `tiktok-shop-strategy`, `marketplace-strategy`, `international-expansion`, `crm-strategy`, `post-purchase-experience`, `community-program-design`, `inventory-and-demand-planning`, `accessibility-compliance`, plus `customer-data-platform-strategy` and `headless-commerce-tradeoffs` from the same wave.

**One UCP-strategy skill**: `ucp-agentic-commerce-strategy` — codifies the 5 design constraints from the Yoru-handoff audit (UCP is one Google+Shopify protocol, not two; Catalog MCP returns aggregate rating only; no caching catalog results or images; agent profile and trust tier is gating; ChatGPT and Claude are not UCP-native consumer surfaces in May 2026). Cites primary sources only.

Skill totals: 47 marketing + creative + 37 engineering + 3 operator = **87**. All pass `bash scripts/validate-skills.sh` with zero warnings.

### Changed

- `scripts/run-skill-evals.js#scoreAssertion` — now handles typed assertions (`{type: 'contains'|'not-contains'|'length-at-least', value}`) in addition to legacy free-form strings. Many v0.7.0 + v0.8.0 skills ship the typed shape; the prior heuristic-only path was under-reporting their pass rate.
- `scripts/run-skill-evals.js#resolveBackend` — defensive against `null`/`undefined` args.
- `scripts/run-skill-evals.js#--max-parallel` default bumped 4 → 8 to match the tier-3 grader's concurrency.
- `package.json#files` — adds `cron/`, `integration/`, `webhook/`, `release-gate/scorecards/`.
- `release-gate/scripts/create-clean-export.js` — include list adds `cron`, `integration`, `test`.
- `lib/grading/categories/skill-eval-live.js` — hash separator switched from a literal NUL byte to `\x1f` (Unit Separator) so the source-file public-content scanner stays clean.

### Notes

- 87 skills validate. Verifier now runs ~60 checks. Aggregate runtime depends on tier-3 inclusion.
- The tier-3 live-model eval is opt-in (`npm run grade -- --tier-3`). The default `npm run grade` runs tiers 1/2/4 only — cheap, fast, reproducible.
- Mutation testing has a hard 10-minute total budget; each mutation has a 60s individual budget. Reverts are tested and idempotent.
- The Neo installer was dry-run-tested against `<neo-home>` but not yet executed. Adam runs `npm run install:neo` post-release.
- Public-safety gate is real: any private-content scanner hit caps composite at 50. The v0.8.0 build hit this once during integration (NUL byte in `skill-eval-live.js` hash separator); fixed before ship.

### v0.9.0+ candidates surfaced during this release

- Hermes ports remaining (MEDIUM/LOW priority): kanban-board UI, telegram/slack messaging gateway, ACP server, web dashboard, plugin `ctx.llm`, voice memo transcription, adversarial-UX self-skill.
- Engineering skills: `chaos-engineering-design`, `dark-launch-strategy`, `migration-window-planning`, `service-deprecation-runbook`, `multi-region-design`, `event-sourcing-tradeoffs`.
- Marketing skills: `ai-search-strategy-2026`, `creator-economy-positioning`, `subscription-tier-design`, `b2b-vs-dtc-positioning`, `wholesale-channel-strategy`.
- Ticketing v3: time-tracking, parent/child hierarchies, auto-archiving by age, full-text search.
- Goal v4: streaming gantt during execution, real-time cost meter, lane-level retry policies with backoff, partial-result recovery.
- Rust expansion: openclaw-agent in Rust, signed-bus client in Rust, taskflow store with WAL.

## 2026-05-19 — v0.7.0 — Rust core workspace, ticketing FSM, goal refinement, public-surface hardening

Status: published.

The next-level pass surfaced by v0.6.0. Lands the Rust core crates (envelope + blackboard + taskflow), the standalone ticketing FSM as a peer to taskflow, goal-template + state-persistence + cost-estimate features on the engineer CLI, 17 new skills (8 engineering + 9 marketing/creative), a Hermes-agent gap audit with prioritized port targets, and a substantial expansion of the public-surface harness (semver consistency, script/bin/files-glob existence checks, agent-contract cross-references, plugin-manifest path checks).

### Added — Rust core workspace (`crates/`)

Three crates under a Cargo workspace, in operator-safe parity with the Node implementations:

- `crates/openclaw-envelope` — Ed25519 envelope signing/verification with a hand-rolled canonical-JSON encoder that matches Node's `JSON.stringify` byte-for-byte. Includes a 15-entry canonical-corpus fixture validated against the Node encoder. The same H2 separation lives here — top-level `signature` stripped only at depth 0, nested `signature` preserved.
- `crates/openclaw-blackboard` — JSONL ledger with mkdir-based lock + public-safety scan parity. Same record shape, same lock semantics.
- `crates/openclaw-taskflow` — FSM transitions matching the Node TaskFlow (queued/claimed/waiting/done/failed/blocked) with the same legal-transition table.

Operator-safe surface only. `cargo` is not a hard build dependency of the Node package; the workspace is shipped for downstream Rust callers and future Rust agent runners.

### Added — agent ticketing FSM (`src/tickets/`)

A peer to taskflow but at a different level of abstraction. Ticketing is the durable record of *human work intent* (request → review → done) while taskflow handles *agent task execution* (claim → done). Both write JSONL ledgers, both have transition tables, but they answer different questions.

- `src/tickets/lib/ticket-store.js` (691 LOC) — FSM with states `open / in-progress / review / done / archived` plus a derived `blocked` flag (any unresolved `depends-on` upstream). JSONL persistence at `release-gate/tickets.jsonl`. Custom error classes: `TicketStateError`, `TicketValidationError`. Idempotent transitions guarded by event hashes.
- `openclaw ticket <action>` subcommand on the engineer CLI — `create`, `assign`, `move`, `block`, `unblock`, `comment`, `archive`, `show`, `list`. Filters: `--status`, `--blocked`, `--assigned-to`, `--priority`.
- `.github/workflows/ticket-sla-escalation.yml` — hourly check; opens an escalation issue when any ticket exceeds its SLA deadline.
- `docs/ticketing.md` — operator guide.

### Added — goal refinement (`bin/openclaw goal`)

- **Goal templates.** 5 prebuilt templates under `lib/goal-templates/templates/*.json`: `ship-release`, `fix-bug`, `build-feature`, `audit-repo`, `daily-summary`. Each binds lanes to roles + coordination patterns and accepts a context string. CLI: `openclaw goal --template ship-release "v0.8.0"` and `openclaw goal --list-templates`.
- **State persistence.** Every goal run writes `<goalsDir>/<goal_id>.json` with the full trace, partial completion state, and last-known lane status. CLI: `--list`, `--show <goal_id>`, `--resume <goal_id>`, `--no-persist`, `--goals-dir <path>`.
- **Cost estimates.** `lib/cost-table.json` with per-MTok USD rates for the current model lineup (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001). `openclaw recap --cost` rolls per-goal USD spend into the recap.
- **Progress emitter.** `--quiet` / `--verbose` flags control per-lane progress on stderr.
- **Live-path integration test** at `test/integration/goal-live-path.test.js` — spawns a live mock agent, runs a goal through the full dispatch → claim → result loop, verifies the persisted state and ledger records. Runs under the package verifier.

### Added — skill catalog (51 → 68)

**8 engineering workflow skills** (engineering total 20 → 28):
`secrets-management`, `database-migration-safety`, `code-review-receiving`, `feature-experiment-design`, `disaster-recovery-exercise-design`, `logging-platform-selection`, `oncall-handoff-rituals`, `postdeploy-verification`.

**9 marketing + AI-creative skills** (Modern Skills 28 → 37):
`influencer-program-design`, `loyalty-program-design`, `pricing-experiments`, `merchandising-strategy`, `attribution-model-design`, `affiliate-program-design`, `retail-buyer-pitch`, `ai-image-generation`, `ai-video-generation`.

The two AI-creative skills bake in current model lineup notes for image (gpt-image-1, ideogram, midjourney) and video (sora, runway, veo, kling, hailuo, pika) generation with operator-safe placeholders. All 68 pass the validator with zero warnings.

Skill totals: 37 marketing + creative + 28 engineering + 3 operator = **68**.

### Added — public-surface harness expansion (`release-gate/scripts/verify-public-surface-harness.js`)

Substantial expansion of the harness with 7 new check categories. Caught real version drift during this release — the `.codex-plugin`, `.cursor-plugin`, and `.opencode` plugin.json files were stale at 0.4.0 while `package.json` was at 0.6.0. The harness now blocks that class of mismatch.

- **Semver consistency.** All 4 plugin manifests + the CHANGELOG top dated header + the latest `vX.Y.Z` git tag must equal `package.json#version`.
- **Script existence.** Every `package.json#scripts` entry that references a path must point at a real file.
- **Bin existence.** Every `package.json#bin` entry must point at a real file with a `#!` shebang.
- **Files-glob existence.** Every `package.json#files` entry must exist on disk.
- **Agent-contract cross-references.** Each `agents/*/CONTRACT.md` cross-reference to another role must resolve.
- **Plugin-manifest skills path.** Each manifest's `skills` field must point at the same real directory.
- **Plugin-manifest hooks path.** Each manifest's `hooks` field must point at a real `hooks.json`.

### Added — Hermes-agent gap audit (`docs/hermes-agent-audit.md`)

1,131-LOC capability gap analysis comparing OpenClaw Frontier Stack against `NousResearch/hermes-agent`. 47 capability rows in each direction, prioritized port targets, and parity notes. The 5 highest-priority Hermes capabilities flagged for v0.8.0 porting: cron-style schedule subsystem, `openclaw doctor` health check, supply-chain advisory check via `osv-scanner`, webhook subscription system, gateway-style event-hook lifecycle.

### Changed

- `scripts/verify-package.js` — `FRONTIER_CHILD_TIMEOUT_MS` default bumped 120000 → 240000 to accommodate the 68-skill validator runtime.
- `scripts/verify-package.js` — adds `ticket-store-test` and `goal-live-path-integration` to the verifier suite.
- `package.json#files` — adds `crates/` and `test/`.
- `release-gate/scripts/create-clean-export.js#include` — adds `crates` and `test`.
- `package.json#description` — updated for v0.7.0 surface.
- `agents/executive-summary/CONTRACT.md` — adds the ticket store as a read source for rollups.

### Notes

- 68 skills validate. Verifier passes after the timeout bump.
- The Rust workspace ships as operator-safe parity, not a Node-side requirement. `cargo test` is opt-in.
- Goal state and ticket store both write JSONL under the same blackboard family; the public-safety scan covers both.

### v0.8.0+ candidates surfaced during this release

- Hermes ports (HIGH priority): cron-style schedule, `openclaw doctor`, supply-chain advisory via osv-scanner, webhook subscriptions, gateway-style event-hook lifecycle.
- Engineering skills: `runbook-writing`, `change-management-policy`, `slo-design`, `query-performance-tuning`, `observability-pillars-integration`, `service-ownership-boundaries`, `capacity-planning`, `data-classification-and-handling`.
- Marketing skills: `customer-data-platform-strategy`, `headless-commerce-tradeoffs`, `tiktok-shop-strategy`, `marketplace-strategy`, `international-expansion`, `crm-strategy`, `post-purchase-experience`, `community-program-design`, `inventory-and-demand-planning`, `accessibility-compliance`.
- Ticketing: templates, multi-assignee, watchers, attachments, SLA pause windows, ticket→goal binding, bulk transitions.
- Goal: pattern-lane failure recovery, streaming progress, cost-table auto-refresh, `--diff`, cancellation tokens, sub-goals, `--gantt`.
- Rust: openclaw-agent Rust binary, Rust eval runner, N-API FFI for the Node harness, harness rewrite.

## 2026-05-19 — v0.6.0 — Skill catalog doubles, coordination layer, live agent runner, autonomous-loop fleet

Status: published.

Largest single release. Doubles the skill catalog (28 → 51), adds the coordination layer that turns the orchestration harness into a real swarm scheduler, ships the live agent runner daemon, expands the autonomous-loop fleet from 1 to 5, and closes pre-existing rough edges (schema bump, install-path correction, slash-command marketplace catalog).

### Added — skill catalog (28 → 51)

**15 ecomm marketing skills** (Modern Skills doubles from 13 → 28). Broad-surface expansion covering the marketing fundamentals not yet in the catalog: `cro`, `copywriting`, `ai-seo`, `seo-audit`, `programmatic-seo`, `schema-markup`, `ads`, `ad-creative`, `ab-testing`, `customer-research`, `product-marketing-positioning`, `launch`, `content-strategy`, `email-marketing`, `social-strategy`. Each integrates with the Modern AI MCP for live data. `ai-seo` bakes in current-as-of-May-2026 AI-search patterns: Query Fan-Out, agentic-experience optimization, the `llms.txt` framing, what-NOT-to-do anti-patterns.

**8 more engineering workflow skills** (engineering total 12 → 20). Filling gaps complementary to obra/superpowers: `code-review-giving`, `local-dev-environment`, `feature-flagging`, `load-testing`, `logging-discipline`, `api-deprecation`, `oncall-rotation-design`, `backup-and-restore`.

Skill totals: 28 marketing + 20 engineering + 3 operator = **51**. 5,000+ LOC of skill content, ~280 eval cases, ~1,500 assertions. All 51 pass the validator with zero warnings.

### Added — coordination patterns

`lib/coordination/` with 4 standalone modules. Each takes the goal id + tasks + ledger + taskflow as inputs and orchestrates one specific coordination shape:

- `fan-out.js` — N independent tasks in parallel
- `fan-in.js` — wait for N upstream results, dispatch a joiner with the union
- `chain.js` — sequential pipeline where each step feeds the next
- `voting.js` — same decision to multiple voters, verdict by quorum + threshold

All four unit-tested. The orchestration harness (`scripts/orchestrate.js`) reads a `pattern` field on each lane and dispatches via the matching coordinator. Mock-mode works without any live agents.

### Added — live agent runner daemon (`bin/openclaw-agent`)

The piece that turns the mock-mode dispatch into real swarm execution. Single-role daemon: started with `--role <role-name>`, parses `agents/<role>/CONTRACT.md` (via pure regex, no markdown lib), polls the blackboard for task-claims addressed to itself, dispatches to the model backend (via the eval-runner's exported `callBackend`), enforces the contract's hard rules POST-output (two-pass: universal regex + contract-derived tokens), writes `result` records on success and `decision: blocked` records on rule violations. Optionally signs records with an Ed25519 identity key. Every event audit-logged to a configurable path under your home directory (defaults documented in `docs/agent-daemon.md`).

Refactored `scripts/run-skill-evals.js` to export `callBackend`, `resolveBackend`, `resolveAuth`, `isLocalHost`, `DEFAULT_ANTHROPIC_ENDPOINT` so the daemon and the workflows can share auth + backend resolution. CLI behaviour unchanged.

### Added — 3 new agent roles

Filling gaps surfaced by v0.5.0:

- `scribe` — owns `CHANGELOG.md` and release-notes. Documents but cannot ship.
- `dependency-warden` — bumps one dep at a time after CHANGELOG review. Narrow lane carved out from architect.
- `eval-runner` — owns scheduled-evals + autonomous-loops cadence; triages drift; cannot modify eval prompts or scripts.

Roster total: 8 (v0.5.0) + 3 = **11 role contracts**.

### Added — 4 new autonomous loops (fleet now 5 total)

- `.github/workflows/dependency-vulnerability-scan.yml` — daily; opens issue on high/critical vulnerabilities
- `.github/workflows/performance-baseline-drift.yml` — weekly; compares against orphan-branch baseline
- `.github/workflows/documentation-staleness.yml` — weekly; flags docs older than 180 days while source moved
- `.github/workflows/prompt-tuning.yml` — monthly; cycles through skills, generates a SKILL.md variant via the model backend, A/Bs it against current evals, opens a draft PR if the variant improves pass rate >10%
- Plus `release-gate/lib/prompt-tuning-template.md` (template for the variant-generation prompt)

Each loop declares scoped `permissions:`, dedups by date+condition, surfaces a failure as a labeled issue.

### Added — `openclaw watch` subcommand

Tails the blackboard JSONL in operator-readable format. Flags: `--blackboard`, `--filter`, `--agent`, `--since`, `--no-color`, `--json`. Polls via `fs.statSync` size-delta (Windows-safe). Example output: `14:04:38  task-claim  orchestrator  goal-test-fan-out-6fb24e  "[fan-out] review file a"`.

### Added — `.claude-plugin/marketplace.json`

The slash-command install command we'd been advertising in the README (`/plugin install ohsonerdy/openclaw-frontier-stack`) didn't actually match Claude Code's documented syntax. The real syntax requires a `marketplace.json` catalog. Added one. Users can now run `/plugin marketplace add ohsonerdy/openclaw-frontier-stack` then `/plugin install openclaw-frontier-stack@openclaw-frontier-stack`.

### Changed

- `scripts/run-skill-evals.js` — eval-report schema bumped `v1` → `v2` (auth field shape changed from string to object in v0.5.0). Migration note added to `docs/skill-eval-telemetry.md`.
- README install commands now docs-grounded for all 4 host platforms (verified from Claude Code, Codex CLI, Cursor, OpenCode docs). Modern Skills table updated to 28 rows; Engineering Skills section added with 20 rows.
- `release-tarball builder` include list adds `lib/`, `release-gate/lib/`, the new manifest dirs.
- `package.json#files` adds `lib/` and `release-gate/lib/`.
- `package.json#bin` adds `openclaw-agent`.

### Notes

- 51 skills validate. 44 verifier checks pass. Eval dry-run reports schema v2.
- 11 role contracts. Strict separation of powers. 60+ cross-referenced file paths verified.
- Engineering Skills' `logging-discipline` initially used literal example emails that tripped the private-content scanner — replaced with `[redacted email]` style placeholders before this release.
- The orchestration harness (`scripts/orchestrate.js`) and the live agent runner (`bin/openclaw-agent`) are decoupled: the orchestrator writes task-claims, the daemon reads them. They don't share process state.
- Mock-mode dispatch (`openclaw goal "..." --mock-agents`) works without any infrastructure — exercise the full pipeline before connecting live agents.

### v0.7.0+ candidates surfaced during this release

- Skills: `secrets-management`, `database-migration-safety`, `code-review-receiving`, `feature-experiment-design`, `disaster-recovery-exercise-design`, `logging-platform-selection`, `oncall-handoff-rituals`, `postdeploy-verification`, `influencer-program-design`, `loyalty-program-design`, `pricing-experiments`, `merchandising-strategy`, `attribution-model-design`, `affiliate-program-design`, `retail-buyer-pitch`
- AI-creative skills (catalog mentions current model lineup but no dedicated skills): `ai-image-generation`, `ai-video-generation`
- MCP tools that skills reference but aren't yet in the spec surface table: `modern.sales.sku_affinity` (used in 4 skills), `modern.surveys.nps_distribution` (used in 4 skills), `modern.subscriptions.cancel_reasons`, `modern.subscriptions.dunning_recovery`, `modern.retention.lapsed_count`, `modern.retention.last_purchase_recency`. Modern AI MCP eng backlog item.

## 2026-05-19 — v0.5.0 — Foundation for engineer-leverage at scale

Status: published.

This release lays the foundation for engineers to orchestrate agent swarms at scale. Three pillars: skill catalog expansion, role contracts, and an orchestration layer.

### Added

#### 12 engineering workflow skills under `skills/`

Complementary to obra/superpowers (does NOT overlap with its TDD / debugging / planning / PR-cycle coverage):

- `incident-response` — severity triage, mitigation order, comms cadence during a Sev 1/2/3
- `root-cause-analysis` — 5-whys with falsifiable hypotheses, fault tree, contributing-factor-vs-root-cause discipline
- `post-mortem-writing` — blameless template, action-item discipline, follow-up tracking
- `architecture-decision-records` — when to write, template, "supersedes" chain, ADR-vs-RFC
- `api-design` — REST/GraphQL/gRPC tradeoffs, versioning, error shapes, pagination, idempotency, backwards-compat taxonomy
- `schema-design` — normalization vs deliberate denormalization, primary keys, indexes, FK cascades, online migration safety
- `dependency-upgrade-safely` — semver discipline, lockfile hygiene, changelog reading, peer-dep traps, rollback planning
- `security-review` — OWASP top-10 per-category red-flag patterns, secret handling, authn-vs-authz boundary review, data-flow review
- `threat-modeling` — STRIDE per data flow, attack trees, abuser stories, likelihood-impact prioritization
- `refactoring-safety` — characterization tests first, refactor-vs-test loop, scope discipline, strangler-fig
- `performance-profiling` — measure-first discipline, profiler selection, slowdown taxonomy (N+1, blocking I/O, GC, lock contention)
- `monitoring-and-alerting` — RED/USE/four-golden-signals, SLI-SLO-SLA, alert-on-symptoms-not-causes, runbook-linking discipline

Each ships with 7 eval cases and 38-51 assertions. 2,767 LOC of skill content across the 12. **Skill catalog total now 28.**

#### Agent roster — 8 role contracts under `agents/`

The role-contract layer that the orchestration harness dispatches against. Each is 157-195 LOC with the 9-section structure (Mission / Hard preconditions / Decision authority / Inputs / Outputs / Ack format / Never-do / Failure modes / Done state):

- `agents/orchestrator/CONTRACT.md` — decomposes `/goal`, dispatches lanes, synthesizes receipts. Cannot self-approve releases. Cannot edit release-gate code.
- `agents/security-sentinel/CONTRACT.md` — ONLY role authorized to issue `PROPOSE_RELEASE` decisions. Operator counter-signs out-of-band.
- `agents/architect/CONTRACT.md` — owns release-gate code, workflows, plugin manifests, harness shape.
- `agents/builder/CONTRACT.md` — writes feature code under non-gated paths. Cannot touch release-gate, agents, workflows, or plugin manifests.
- `agents/reviewer/CONTRACT.md` — gates PRs against conventions. Cannot self-review (author ≠ reviewer enforced).
- `agents/researcher/CONTRACT.md` — investigates open questions; writes facts only, no code.
- `agents/marketing-strategist/CONTRACT.md` — proposes Modern Skills briefs; does not author skills directly.
- `agents/executive-summary/CONTRACT.md` — daily/weekly operator-facing rollups as fact records.

Plus `agents/README.md` — roster overview and activation guide.

#### Orchestration harness + engineer CLI + one autonomous loop

The pillars that turn the skill + role library into a working multi-agent platform:

- **`bin/openclaw`** — engineer CLI. Subcommands: `goal`, `status`, `dispatch`, `recap`. Wired via `package.json#bin`.
- **`scripts/orchestrate.js`** — 154 LOC harness. Reads a `/goal` JSON, decomposes into lanes per role, writes task-claims to the blackboard, polls for results, synthesizes. Includes `--mock-agents` mode so the harness can run end-to-end without live agents connected.
- **`.github/workflows/autonomous-loops.yml`** — 323 LOC workflow. ONE concrete autonomous loop: weekly skill-eval-drift detection. Compares current eval pass-rate against the previous week's baseline; if any skill regressed >10%, opens a draft PR + an `eval-drift` issue. Cron schedule plus `workflow_dispatch`.
- **`docs/orchestration.md`** — 326 LOC operator guide. `/goal` schema, lane→role dispatch model, custom-loop template, failure modes, trust model.

#### Multi-model eval support

`scripts/run-skill-evals.js` now supports three backends:

- **Anthropic** (default) — OAuth-first auth (Pro/Max subscription), API key opt-in fallback
- **Ollama** — `--endpoint http://localhost:11434 --api-format openai` with optional `OPENCLAW_EVAL_API_KEY`
- **vLLM** / any OpenAI-compatible server — same flag pattern, Bearer auth via `OPENCLAW_EVAL_API_KEY` or `OPENAI_API_KEY`

`docs/skill-eval-telemetry.md` adds a "Multi-model backends" section with Ollama + vLLM walkthroughs. `.github/workflows/scheduled-evals.yml` accepts the new endpoint/format/key secrets.

The report's `auth` field shape changes from string (`"oauth"`) to object (`{ kind, endpoint, apiFormat }`). Schema version bumped accordingly.

### Changed

- `scripts/validate-skills.sh` — `metadata.data_dependencies` is optional (procedural skills have no MCP backend); scope cross-reference detection accepts `use <skill>` in addition to `see X` / `for X, see Y`.
- `scripts/run-skill-evals.js` — procedural skills without `evals/evals.json` reported as skipped, not failed.
- `.github/workflows/release.yml` — switched to `--notes-file` from inline `--notes "..."`, eliminating the shell-escape failure on multi-line CHANGELOG entries with backticks. Future tags auto-release cleanly.
- Release-tarball builder — include list adds `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, `hooks/`, `bin/`, and `agents/`.
- `package.json#files` — ships the new directories. `bin.openclaw` declared.
- `README.md` — supported-agent badges row (Claude Code, Codex CLI, Cursor, OpenCode), Operator Skills callout, interoperability tagline.

### Notes

- **28 skills validate, all evals dry-run ok, all 44 verifier checks pass against this tree.**
- The orchestration harness runs in mock mode without any infrastructure. `node bin/openclaw goal "ship X" --mock-agents` produces a synthesized trace immediately. Live agent dispatch requires connecting agents to the blackboard separately.
- The autonomous-loops workflow is one example. The pattern (CI loop → blackboard fact → conditional PR/issue) is the template for adding more loops (incident-detection, drift-detection-on-deps, etc.) in future releases.
- The 8 role contracts reference real file paths in this repo — 63 cross-references verified at build time.

### v0.5.1+ candidates surfaced during this release

- More agent roles: `scribe` (CHANGELOG ownership), `dependency-warden` (deps lane), `eval-runner` (drift cadence ownership)
- More engineering skills: `code-review-giving`, `local-dev-environment`, `feature-flagging`, `load-testing`, `logging-discipline`, `api-deprecation`, `oncall-rotation-design`, `backup-and-restore`
- IPC-race fix in v0.4.0 was specific to `eval-blackboard-contention.js`. Other evals (`eval-frontier-orchestration-scale.js`, `eval-self-healing-recovery.js`) inspected — they're single-process, no IPC pattern, no fix needed.

## 2026-05-18 — v0.4.0 — Interoperability + skill expansion

Status: published.

### Added

- **5 new ecomm marketing skills** under `skills/`, bringing Modern Skills to 13 total:
  - `cross-sell-mapping` — SKU-affinity-driven cross-sell sequencing.
  - `pricing-discipline` — when to discount and when not to.
  - `referral-program-design` — double-sided rewards, fraud-resistance, viral coefficient math.
  - `nps-and-detractor-handling` — detractor recovery, promoter activation, do-not-contact rules.
  - `dunning-deep-dive` — retry schedule design, reason-code segmentation, recovery flow length.
- **3 operator skills** under `skills/`, folded in from the frontier-skills companion plugin:
  - `safe-public-release` — gate before pushing to a public remote (history scan + owner-upload-approval).
  - `durable-task-ledger` — coordinate multi-step work across subagents via the JSONL blackboard ledger.
  - `verified-history-scan` — audit full git history for leaks across every commit's tree.
- **Hooks** under `hooks/`:
  - `private-content-scan.js` (Stop) — scan working-tree changes for private content before user sees the turn.
  - `git-push-gate.js` (PreToolUse:Bash) — block pushes to public remotes that fail the verifier.
- **Multi-platform plugin manifests** at `.codex-plugin/`, `.cursor-plugin/`, `.opencode/` (joining the existing `.claude-plugin/`). Each declares the same `skills/` + `hooks/` surface for its respective agent host. Same content, multiple front doors.
- **OAuth-first eval auth** in `scripts/run-skill-evals.js`. Live mode now prefers `ANTHROPIC_OAUTH_TOKEN` (charged to the user's Pro/Max subscription) and falls back to `ANTHROPIC_API_KEY` (per-token API billing) only when the OAuth token is absent. Scheduled-evals workflow updated to accept either secret.
- **blackboard-contention-eval flake fix.** Root cause: parent listened on `child.on('exit')` which fires before stdio pipes drain on slow CI runners. Fix: use the already-declared `'ipc'` channel as the primary delivery path; resolve on `'close'` not `'exit'`; keep stdout-write as fallback. 10/10 local stability runs.

### Changed

- `scripts/validate-skills.sh` — `metadata.data_dependencies` is now OPTIONAL (operator skills don't have MCP backends); scope cross-reference detection accepts "use <skill>" in addition to "see X" / "for X, see Y".
- `scripts/run-skill-evals.js` — skills without `evals/evals.json` (procedural runbooks) are reported as skipped, not failed.
- Release-tarball builder — added `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`, and `hooks/` to the include list so they ship in the public-release tarball.
- `package.json` — `files` includes the four manifest dirs + `hooks/`; `keywords` adds the interoperability keywords.
- Skill phrasing pass — operator skills now read as agent-host-neutral ("agent-1" as example identifier, "your agent host's plugins directory (Claude Code, Codex, Cursor, OpenCode)" instead of "Claude Code plugins directory").

### Notes

- 16 skills total. 13 marketing (Modern Skills) + 3 operator. All pass `npm run verify:skills` and `npm run eval:dry`.
- The skills follow the Agent Skills specification at agentskills.io. They install in any agent host that reads `.<host>-plugin/plugin.json` and the standard `skills/` layout.
- The Modern AI MCP integration is unchanged from v0.2.0: skills name their tools by literal `modern.<domain>.<tool>` identifier and fall back to asking the user when the MCP is not connected.

## 2026-05-18 — v0.3.0 — Distribution + automation polish

Status: published.

### Added

- **GitHub Release automation** — new workflow at `.github/workflows/release.yml` triggers on `v*.*.*` tag push. Runs full verifier + history scan + skill validator, builds the release tarball, extracts release notes from `CHANGELOG.md`, and creates / updates the GitHub Release with the tarball attached.
- **Tenant context template** at `templates/agents/modern-ai-context.example.md`. Drop-in template for the `.agents/modern-ai-context.md` file every Modern Skill reads. Documents the brand voice, ICP, product catalog, channels, KPI, do-not-contact, and notes sections. Onboarding flow can populate it automatically; this is the manual fallback.
- **Skill eval runner** at `scripts/run-skill-evals.js`. Two modes:
  - Dry-run (default): validates `evals.json` file structure across all skills, no API calls. Wired as `npm run eval:dry`.
  - Live (`--live --model <model-id>`): calls the Claude API with each eval's prompt against the skill's `SKILL.md` as system prompt, scores assertions via key-phrase substring matching. Requires `ANTHROPIC_API_KEY`. Wired as `npm run eval:live`.
- **README polish** — badges (build status, latest release, license, Node version, Agent Skills spec), inline plugin install command, full Modern AI MCP connect snippet, eval-runner section, link to the tenant context template.

### Changed

- CHANGELOG header restored to the canonical location (the change-summary line was displaced by an earlier commit).

## 2026-05-18 - runtime supervisor guidance

### Changed

- Clarified that one-shot health checks should use a native scheduler or a
  persistent wrapper when process-manager state is treated as runtime health.
- Added PM2 template guidance to keep public ops examples free of misleading
  `stopped` service states.

## 2026-05-18 — v0.2.0 — Modern Skills integration

Status: published.

### Added

- **Modern Skills plugin** — eight ecomm-shaped marketing skills authored by Modern AI, integrated into this repository's Claude Code plugin surface:
  - `subscription-growth` — acquisition and trial-to-paid mechanics for subscription brands.
  - `repeat-purchase` — second-purchase conversion and replenishment timing.
  - `paid-ltv-optimization` — channel-by-channel paid acquisition grounded in cohort LTV and payback period.
  - `cart-abandonment-recovery` — checkout friction taxonomy and multi-channel recovery flow design.
  - `subscription-churn` — voluntary and involuntary churn diagnosis, save flow design, dunning hardening.
  - `bundle-pricing` — SKU affinity, anchor pricing, good-better-best tiering for AOV and margin lift.
  - `cohort-retention` — survival curve interpretation, cohort-of-acquisition impact on LTV, test design.
  - `winback-flows` — lapse-segment taxonomy, recency-based offer ladders, do-not-contact rules.
- `.claude-plugin/plugin.json` — plugin manifest.
- `scripts/validate-skills.sh` — skill validator enforcing frontmatter shape, trigger phrase density, scope cross-references, line limits, and per-skill eval coverage.
- `docs/skills-integration-spec.md` — engineering integration spec for skills ↔ Modern AI MCP wiring.
- 5–8 evaluation cases per skill at `skills/<name>/evals/evals.json`.
- Skill validation wired into `npm run verify` and into the pre-push hook.

### Notes

- Skills look for `.agents/modern-ai-context.md` at the start of every invocation and read brand, ICP, and KPI context from it when present.
- Every skill works without the Modern AI MCP connected — falls back to asking the user. With the MCP connected, pulls data directly via `modern.<domain>.<tool>` calls.
- Plugin and skills are MIT-licensed and original to this repository.

## 2026-05-17 — v0.1.1 — Audit hardening

Status: published.

### Added

- H2 audit regression test at `src/signed-bus/test/nested-signature-tamper.test.js` covering the nested-signature canonicalisation fix. Wired into `npm run verify`.

### Notes

- v0.1.1 closes the 2026-05-17 audit cycle: C5 nats optional + lazy-load, H1 install lifecycle removed, H2 envelope depth-zero canonicalize + regression test, H4 IPv4 deny narrowed to RFC1918+CGNAT, H5 mock-mcp URL deny narrowed to private targets, pre-push hook, owner-upload-approval verifier, centralized private-patterns scanner.

## 2026-05-17 — production release

Status: published production release after verification, reviewer approvals, license selection, and explicit owner upload approval.

### Added

- Clean architecture package README, release scope, verification flow, and architecture diagrams.
- Synthetic acceptance scenario swarm showing Orchestrator, Architect, Scout, Builder, Reviewer, and Sentinel coordination.
- Signed bus envelope helpers and local verification tests.
- JSONL blackboard production implementation with task, path, fact, decision, and result records.
- TaskFlow reference runtime for durable task orchestration.
- Memory adapter examples for RAG, CAG preload, compaction, and promotion filtering.
- Skill Forge acceptance scenario registry and safe read-only acceptance scenario skill.
- Mock external integration adapter.
- Mission Control sidecar acceptance scenario data and dry-run writeback intent.
- Runtime operations templates for common supervisors and health snapshots.
- GitHub hygiene templates for contribution, security, issue, and pull request workflows.
- Release-gate artifacts for reviewer decisions, evidence index, release notes, license selection, release manifest, and export parity checks.
- Goal operating system docs and local acceptance scenario for `/goal` card, lane receipts, fail-closed verifier, synthesis, and 30-minute operator updates.
- Agent operating system docs covering Orchestrator-led roles, coding-team execution path, cross-agent coordination, setup, and production smoke/acceptance scenario path.
- Public architecture naming uses generic role labels only; private deployment personas are intentionally out of scope for the public package.

### Verification

- Run `node examples/goal-loop-demo/run-goal-demo.js` from the package root.
- Run `node scripts/verify-package.js` from the package root.
- Run `node scripts/verify-package.js` before any future release decision.
- Current expected release status is published for the production release; future release candidates must pass reviewer, license, and owner upload gates before publication.

### Publication status

This package was approved by the owner for GitHub upload and production release after the production-safe verifier, reviewer matrix, license gate, and upload approval gates passed. Future public releases require the same gate sequence and explicit owner approval.
