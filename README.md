# OpenClaw Frontier Stack

[![Verify package](https://github.com/ohsonerdy/openclaw-frontier-stack/actions/workflows/verify-package.yml/badge.svg?branch=main)](https://github.com/ohsonerdy/openclaw-frontier-stack/actions/workflows/verify-package.yml)
[![Release](https://img.shields.io/github/v/release/ohsonerdy/openclaw-frontier-stack?logo=github)](https://github.com/ohsonerdy/openclaw-frontier-stack/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-43853d?logo=node.js&logoColor=white)](package.json)
[![Agent Skills spec](https://img.shields.io/badge/Agent_Skills-spec_v1-7c3aed)](https://agentskills.io/specification.md)

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-d97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-plugin-10a37f?logo=openai&logoColor=white)](https://developers.openai.com/codex/plugins)
[![Cursor](https://img.shields.io/badge/Cursor-skills-111111)](https://cursor.com/docs/skills)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-0ea5e9)](https://opencode.ai/docs/plugins)

> Current release status: see [STATUS.md](STATUS.md).

OpenClaw Frontier Stack is a **production-ready, drop-in multi-agent coding orchestration stack** — interoperable across Claude Code, Codex, Cursor, and OpenCode — for shared state, signed coordination, durable task ownership, memory, observability, and fail-closed release gates. It also ships **Modern Skills** (13 ecomm marketing skills, integrated with the Modern AI MCP), **Operator Skills** (safe public releases, durable task coordination, full-history audits), **12 engineering workflow skills** (incident response, ADRs, schema design, threat modeling, performance profiling, monitoring, and more), and an **8-role agent roster** with an `openclaw` CLI for orchestrating multi-lane work across them.

This repository is the public source package. It ships production core modules, operator-ready templates, local acceptance scenarios, and release harnesses that can be installed and verified from a fresh checkout. Private runtime state is intentionally excluded: operators provide their own credentials, hosts, policy bindings, and deployment configuration.

Included capabilities:

- Orchestrator-centered goal and release execution
- Architect, Sentinel, Scout, Builder, and Reviewer role lanes
- Signed inter-agent envelopes over a bus
- Blackboard coordination with path/task claims
- RAG/vector memory, CAG, and compaction patterns
- TaskFlow-style durable orchestration and result contracts
- Mission Control visual control-plane schema and local board data
- Observability, eval, doctor, and release/privacy gates
- Bus and blackboard protocol for multi-agent coding coordination
- NATS/JetStream signed-bus implementation
- Durable production-safe JSONL blackboard ledger implementation
- Memory acceptance scenario for RAG, CAG preload, and compaction
- End-to-end trace model for user request to release decision
- Sentinel release-gate checklist and reviewer decision template
- Release manifest generation for target-bound release preparation
- Skill Forge registry and safe local skill package
- Runtime operations templates for PM2, launchd, systemd, and safe health snapshots
- Fleet orchestration and specialist delegation registry
- MCP/external integration adapter contract with local test adapter
- Fleet parity and agent-baseline checklist
- Mermaid architecture diagrams
- **Modern Skills plugin** — ecomm marketing skills (CRO-shaped, subscription growth, paid LTV optimization, etc.) authored by Modern AI and integrated with the Modern AI MCP. See [Modern Skills](#modern-skills) below.
- TaskFlow/result-contract documentation for durable orchestration
- GitHub repository hygiene docs and community-template pack
- Security/governance lane (`FR-SECURITY-GOV-001`) for production-safe vault policy, no-public-secrets checks, quorum, approval gates, and incident deductions
- Goal operating system: `/goal` card format, lane receipts, fail-closed verifier, synthesis loop, and operator update behavior
- Agent operating system: documented roles, launch path, coding-team execution path, cross-agent coordination model, and smoke commands
- Remote approval/state parity: read-only approval requests, state snapshots, diff/test receipts, and reviewer decisions
- Self-healing recovery eval: stale blocker detection, owner/action classification, unsafe auto-fix refusal, and safe receipt-path retry loop

## Modern Skills

This repository ships **Modern Skills** — an interoperable agent plugin (Claude Code, Codex, Cursor, OpenCode) with 13 ecomm-shaped marketing skills authored by Modern AI:

| Skill | Use |
|---|---|
| `subscription-growth` | Acquisition and trial-to-paid mechanics for subscription brands |
| `repeat-purchase` | Second-purchase conversion and replenishment timing for catalog brands |
| `paid-ltv-optimization` | Channel-by-channel paid decisions grounded in cohort LTV and payback |
| `cart-abandonment-recovery` | Checkout friction taxonomy and multi-channel recovery flow design |
| `subscription-churn` | Voluntary and involuntary churn diagnosis, save flows, dunning hardening |
| `bundle-pricing` | SKU affinity, anchor pricing, good-better-best tiering for AOV and margin lift |
| `cohort-retention` | Survival curve interpretation, cohort impact on LTV, intervention test design |
| `winback-flows` | Lapse-segment taxonomy, recency-based offer ladders, do-not-contact rules |
| `cross-sell-mapping` | SKU-affinity-driven cross-sell sequencing |
| `pricing-discipline` | When to discount and when not to |
| `referral-program-design` | Double-sided rewards, fraud-resistance, viral coefficient math |
| `nps-and-detractor-handling` | Detractor recovery, promoter activation, do-not-contact rules |
| `dunning-deep-dive` | Retry schedule design, reason-code segmentation, recovery flow length |

Each skill ships with 5–8 eval cases, an opinionated framework, and explicit MCP tool dependencies. With the [Modern AI MCP](https://platform.modern.ai/help-center/how-to/connect-claude-desktop) connected, skills pull live data (sales, ad spend, attribution, retention) automatically; without it, they fall back to asking the user.

### Install as a plugin

The repository ships four plugin manifests — `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, and `.opencode/` — each declaring the same `skills/` + `hooks/` surface for its host. Pick your agent below. Every block names either a docs-confirmed install command or an explicit manifest-pointer fallback; commands that the host's docs do not currently document are flagged.

**Claude Code** — clone the repo and load it as a plugin directory (the `--plugin-dir` flag is the path documented in [Claude Code plugins docs](https://code.claude.com/docs/en/plugins#test-your-plugins-locally) for loading a plugin from a local path; the manifest at `.claude-plugin/plugin.json` is auto-detected):

```bash
git clone https://github.com/ohsonerdy/openclaw-frontier-stack.git
claude --plugin-dir ./openclaw-frontier-stack
```

For session-persistent install via the official marketplace flow, see [Claude Code marketplace docs](https://code.claude.com/docs/en/discover-plugins) — `/plugin install <plugin-name>@<marketplace>` requires the source repo to publish a `.claude-plugin/marketplace.json` catalog; this repo currently ships only a single plugin manifest, so the `--plugin-dir` path is the docs-grounded route until a marketplace catalog is added.

Manifest: [.claude-plugin/plugin.json](.claude-plugin/plugin.json).

**Codex CLI** — the Codex plugin docs ([developers.openai.com/codex/plugins](https://developers.openai.com/codex/plugins)) currently describe an interactive flow only (`codex` then `/plugins`, then **Install plugin** from a marketplace listing), and do not document a one-liner install command for an arbitrary GitHub repository. Until that ships, the manifest-pointer fallback is to vendor the manifest into a path Codex reads:

```bash
git clone https://github.com/ohsonerdy/openclaw-frontier-stack.git
# Project-scoped: copy or symlink .codex-plugin/ and skills/ into the
# Codex plugin path documented by your Codex CLI version.
```

Manifest: [.codex-plugin/plugin.json](.codex-plugin/plugin.json).

**Cursor** — the Cursor docs ([cursor.com/docs/skills](https://cursor.com/docs/skills)) describe a UI-based install only: **Cursor Settings → Rules → Project Rules → Add Rule → Remote Rule (GitHub)**, then paste this repository's URL. No command-line install command is documented. Manifest-pointer fallback for project-local install:

```bash
git clone https://github.com/ohsonerdy/openclaw-frontier-stack.git
# Vendor skills/ into .cursor/skills/ at the project root, or point the
# Remote Rule at this repository's GitHub URL.
```

Manifest: [.cursor-plugin/plugin.json](.cursor-plugin/plugin.json).

**OpenCode** — OpenCode supports plugins via npm package name in `opencode.json` or as local files under `.opencode/plugins/` ([opencode.ai/docs/plugins](https://opencode.ai/docs/plugins)). This repository is not currently published to npm, so the docs-grounded route is the local-files path:

```bash
git clone https://github.com/ohsonerdy/openclaw-frontier-stack.git
# Either vendor .opencode/ into your project (it ships the plugin manifest),
# or symlink the cloned tree under .opencode/plugins/ at the project root.
```

Manifest: [.opencode/plugin.json](.opencode/plugin.json).

For any other agent that supports the [Agent Skills specification](https://agentskills.io/specification.md), point the plugin loader at this repository or vendor the `skills/` directory directly. See [docs/skills-integration-spec.md](docs/skills-integration-spec.md) for the engineering integration spec.

### Connect the Modern AI MCP (recommended)

For live sales / ad spend / attribution / retention data, connect the Modern AI MCP. Generate an API key at [Account → API Keys](https://platform.modern.ai/account/api-keys), then add to your agent's MCP config:

```json
{
  "mcpServers": {
    "modern-mcp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://mcp.modern.ai/mcp",
        "--header", "Authorization: Bearer <your-api-key>"
      ]
    }
  }
}
```

Full setup for each agent: [How to Connect Claude Desktop](https://platform.modern.ai/help-center/how-to/connect-claude-desktop).

### Tenant context file

Skills look for `.agents/modern-ai-context.md` at the start of every invocation — your brand voice, ICP, product catalog, ad channels, KPI targets. A populated template lives at [templates/agents/modern-ai-context.example.md](templates/agents/modern-ai-context.example.md). Copy it into your project root and fill in the placeholders.

### Skill development

- Plugin manifest: [.claude-plugin/plugin.json](.claude-plugin/plugin.json)
- Skills: [skills/](skills/)
- Engineering integration spec: [docs/skills-integration-spec.md](docs/skills-integration-spec.md)
- Validate skill structure: `bash scripts/validate-skills.sh` (or `npm run verify:skills`)
- Eval dry-run: `npm run eval:dry` (validates eval file structure, no API calls)
- Eval live mode: `npm run eval:live -- --model claude-sonnet-4-6` (requires `ANTHROPIC_API_KEY`)

### Nightly scheduled evals

A scheduled GitHub Actions workflow runs the live eval suite against every Modern Skill once per day, persists the JSON report as a workflow artifact, and opens (or updates) an issue under the `eval-regression` label when any assertion fails. Triggered nightly at 09:00 UTC and on-demand via `workflow_dispatch` with `model` and `skill` inputs. Configure with the `ANTHROPIC_API_KEY` repo secret; optional success-comment routing via the `EVAL_TRACKING_ISSUE` repo variable. Operator guide and triage decision tree:

- Workflow: [.github/workflows/scheduled-evals.yml](.github/workflows/scheduled-evals.yml)
- Operator doc: [docs/skill-eval-telemetry.md](docs/skill-eval-telemetry.md)

## Operator Skills

Three host-neutral operator skills ship alongside Modern Skills under `skills/`. Folded in from the frontier-skills companion plugin in v0.4.0, they are agent-host-agnostic and install through the same four manifests above.

| Skill | Use |
|---|---|
| `safe-public-release` | Release-time gate before pushing to a public remote. Runs the private-content scanner over the working tree and full git history, verifies the owner upload approval is bound to the candidate hash, and blocks the push on any failure |
| `durable-task-ledger` | Coordinate multi-step work across subagents and sessions via an append-only JSONL ledger of task claims, path claims, and result receipts so parallel agents do not stomp on each other |
| `verified-history-scan` | Audit the full git history (every commit's tree) for private-content leaks before publishing a previously-private repo, after a force-push, or any time you need to confirm a history rewrite was complete |

Each operator skill is a procedural runbook — no MCP backend, no eval suite — and works in any agent host that reads the Agent Skills specification.

## Engineering Skills

Twelve engineering workflow skills ship under `skills/`, added in v0.5.0. Each is a host-neutral procedural skill with 7 eval cases and 38–51 assertions. They are complementary to other engineering skill libraries (no overlap with TDD / debugging / planning / PR-cycle coverage in obra/superpowers) and install through the same four manifests as the marketing and operator skills above.

| Skill | Use |
|---|---|
| `incident-response` | Severity triage, mitigation order, comms cadence during a Sev 1/2/3 |
| `root-cause-analysis` | 5-whys with falsifiable hypotheses, fault tree, contributing-factor-vs-root-cause discipline |
| `post-mortem-writing` | Blameless template, action-item discipline, follow-up tracking |
| `architecture-decision-records` | When to write, template, "supersedes" chain, ADR-vs-RFC |
| `api-design` | REST/GraphQL/gRPC tradeoffs, versioning, error shapes, pagination, idempotency, backwards-compat taxonomy |
| `schema-design` | Normalization vs deliberate denormalization, primary keys, indexes, FK cascades, online migration safety |
| `dependency-upgrade-safely` | Semver discipline, lockfile hygiene, changelog reading, peer-dep traps, rollback planning |
| `security-review` | OWASP top-10 per-category red-flag patterns, secret handling, authn-vs-authz boundary review, data-flow review |
| `threat-modeling` | STRIDE per data flow, attack trees, abuser stories, likelihood-impact prioritization |
| `refactoring-safety` | Characterization tests first, refactor-vs-test loop, scope discipline, strangler-fig |
| `performance-profiling` | Measure-first discipline, profiler selection, slowdown taxonomy (N+1, blocking I/O, GC, lock contention) |
| `monitoring-and-alerting` | RED/USE/four-golden-signals, SLI-SLO-SLA, alert-on-symptoms-not-causes, runbook-linking discipline |

Together with the 13 Modern Skills and 3 Operator Skills, the public skill catalog is **28 skills total**.

## Agent roster and orchestration CLI

An eight-role agent roster ships under [`agents/`](agents/), added in v0.5.0. Each role is a host-neutral CONTRACT.md with explicit mission, hard preconditions, decision authority, ack format, and forbidden paths — the orchestration harness reads these contracts when dispatching multi-lane work. The roster is `orchestrator`, `security-sentinel`, `architect`, `builder`, `reviewer`, `researcher`, `marketing-strategist`, and `executive-summary`. Separation of powers is enforced at the contract layer (the orchestrator dispatches but does not approve releases; the security-sentinel proposes releases but does not counter-sign its own proposals; the builder writes feature code but cannot touch release-gate code, workflows, or plugin manifests; and so on). See [`agents/README.md`](agents/README.md) for the roster overview, activation triggers, and the nine-section contract template every role follows.

The engineer CLI lives at [`bin/openclaw`](bin/openclaw) (wired via `package.json#bin`) with subcommands `goal`, `status`, `dispatch`, and `recap`. The orchestration harness at [`scripts/orchestrate.js`](scripts/orchestrate.js) reads a `/goal` JSON, decomposes into per-role lanes, writes task-claims to the blackboard, polls for results, and synthesizes. A `--mock-agents` mode runs the harness end-to-end without live agents connected, so `node bin/openclaw goal "ship X" --mock-agents` produces a synthesized trace immediately. Full operator guide: [`docs/orchestration.md`](docs/orchestration.md).

## Current status

Published production source package with local verification gates. This repository is the canonical public source. New tagged releases, package-registry publishes, hosted deployments, external announcements, or customer-specific deployments require fresh target-bound release approval.

The root `package.json` is the convenience entrypoint for clean-checkout install, acceptance scenarios, verification, and release artifact packaging.

## Download and run in 5 minutes

Prerequisite: Node.js 20 or newer. No external services, credentials, package installs, or private OpenClaw runtime state are required for local acceptance scenarios.

```bash
git clone <repository-url> openclaw-frontier-stack
cd openclaw-frontier-stack
npm install --ignore-scripts
node scripts/check-environment.js
npm run smoke
npm run verify
npm run release:pack
```

Expected result:

- `npm run smoke` runs the goal-loop, coding-swarm, memory, and remote approval/state parity acceptance scenarios.
- `npm run verify` runs the production verifier and writes `release-gate/reports/latest-verification.json`.
- `npm run release:pack` creates a downloadable npm tarball under `release-gate/artifacts/`.

If you are running from a downloaded tarball instead of Git, unpack it, enter the package directory, and run the same `npm run smoke` and `npm run verify` commands.

## License

MIT License. See [LICENSE](LICENSE).

## What this is for

Engineers should be able to inspect and run local acceptance scenarios showing how goals and coding agents coordinate safely:

1. Operator submits `/goal`.
2. Orchestrator creates a durable goal card and lane assignments.
3. Builder, Docs, Verifier, Release Manager, and Sentinel produce receipts.
4. Verifier fails closed on missing files, missing receipts, or failed checks.
5. Orchestrator synthesizes what shipped, what was verified, and what remains red.
6. In the coding swarm scenario, Architect, Scout, Builder, Reviewer, and Sentinel coordinate through envelopes and blackboard claims.
7. Mission Control shows state, claims, tasks, and traceable results.

## Quick smoke path

```bash
npm run smoke
npm run verify
```

Equivalent direct commands:

```bash
node examples/goal-loop-demo/run-goal-demo.js
node examples/demo-swarm/run-demo.js
node examples/memory-demo/run-memory-demo.js
node examples/remote-approval-demo/run-remote-approval-demo.js
node scripts/eval-self-healing-recovery.js
node scripts/eval-security-governance.js
node scripts/verify-package.js
```

Start with:

- [Goal system](docs/goal-system.md)
- [Agent system](docs/agent-system.md)
- [Verification flow](docs/verification-flow.md)
- [Remote approval/state parity](docs/remote-approval-state-parity.md)
- [Security and governance](docs/security-governance.md)
- [Self-healing recovery eval](docs/evaluations/self-healing-recovery-eval.md)

## What this excludes

No live memories, transcripts, credentials, OAuth state, private hostnames/IPs/paths, client context, personal Telegram IDs, private automation context, raw logs, session DBs, vector stores, backups, or personal cron jobs. Production deployments bind this stack to operator-supplied configuration and private infrastructure outside the public repository.
