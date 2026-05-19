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

OpenClaw Frontier Stack is a **production-ready, drop-in multi-agent coding orchestration stack** — interoperable across Claude Code, Codex, Cursor, and OpenCode — for shared state, signed coordination, durable task ownership, memory, observability, and fail-closed release gates. It also ships **Modern Skills** — ecomm marketing skills for AI agents, integrated with the Modern AI MCP — and **Operator Skills** for safe public releases, durable task coordination, and full-history audits.

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

The repository ships four plugin manifests — `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, and `.opencode/` — each declaring the same `skills/` + `hooks/` surface for its host. Pick your agent below.

**Claude Code** — slash-command install:

```
/plugin install ohsonerdy/openclaw-frontier-stack
```

Manifest: [.claude-plugin/plugin.json](.claude-plugin/plugin.json). Docs: [Claude Code plugins](https://docs.claude.com/en/docs/claude-code/plugins).

**Codex CLI** — open the interactive plugin browser inside the CLI:

```
codex
/plugins
```

Then point the loader at this repository, or vendor `skills/` and `hooks/` into a path Codex reads (project-scoped `.agents/skills/` or the user-scoped equivalent under your home directory). Manifest: [.codex-plugin/plugin.json](.codex-plugin/plugin.json). Docs: [Codex CLI plugins](https://developers.openai.com/codex/plugins).

**Cursor** — install via Cursor Settings → Rules → Add Rule → Remote Rule (GitHub), and point at this repository URL. Alternatively, vendor `skills/` into `.cursor/skills/` at the project root. Manifest: [.cursor-plugin/plugin.json](.cursor-plugin/plugin.json). Docs: [Cursor skills](https://cursor.com/docs/skills).

**OpenCode** — add the plugin to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["openclaw-frontier-stack"]
}
```

Manifest: [.opencode/plugin.json](.opencode/plugin.json). Docs: [OpenCode plugins](https://opencode.ai/docs/plugins).

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
