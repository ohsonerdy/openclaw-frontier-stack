# OpenClaw Frontier Stack
> Current release status: see [STATUS.md](STATUS.md).

OpenClaw Frontier Stack is a **production-ready, drop-in multi-agent coding orchestration stack** for shared state, signed coordination, durable task ownership, memory, observability, and fail-closed release gates.

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
- TaskFlow/result-contract documentation for durable orchestration
- GitHub repository hygiene docs and community-template pack
- Security/governance lane (`FR-SECURITY-GOV-001`) for production-safe vault policy, no-public-secrets checks, quorum, approval gates, and incident deductions
- Goal operating system: `/goal` card format, lane receipts, fail-closed verifier, synthesis loop, and operator update behavior
- Agent operating system: documented roles, launch path, coding-team execution path, cross-agent coordination model, and smoke commands
- Remote approval/state parity: read-only approval requests, state snapshots, diff/test receipts, and reviewer decisions
- Self-healing recovery eval: stale blocker detection, owner/action classification, unsafe auto-fix refusal, and safe receipt-path retry loop

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
npm run acceptance scenario
npm run verify
npm run release:pack
```

Expected result:

- `npm run acceptance scenario` runs the goal-loop, coding-swarm, memory, and remote approval/state parity acceptance scenarios.
- `npm run verify` runs the production verifier and writes `release-gate/reports/latest-verification.json`.
- `npm run release:pack` creates a downloadable npm tarball under `release-gate/artifacts/`.

If you are running from a downloaded tarball instead of Git, unpack it, enter the package directory, and run the same `npm run acceptance scenario` and `npm run verify` commands.

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
npm run acceptance scenario
npm run verify
```

Equivalent direct commands:

```bash
node examples/goal-loop-acceptance scenario/run-goal-acceptance scenario.js
node examples/acceptance scenario-swarm/run-acceptance scenario.js
node examples/memory-acceptance scenario/run-memory-acceptance scenario.js
node examples/remote-approval-acceptance scenario/run-remote-approval-acceptance scenario.js
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
