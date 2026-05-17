# OpenClaw Frontier Stack
> Current release status: see [STATUS.md](STATUS.md).


A clean-room OpenClaw full-stack architecture package for building coding swarms with shared state, memory, task ownership, and verifiable release gates.

This package is intentionally **not** a dump of a live private runtime. It is a professional reference implementation and documentation set extracted from operational patterns:

- Orchestrator as the central coordinating role
- Architect, Sentinel, Scout, Builder, and Reviewer role agents
- signed inter-agent envelopes over a bus
- blackboard coordination with path/task claims
- RAG/vector memory, CAG, and compaction patterns
- TaskFlow-style durable orchestration and result contracts
- Mission Control as a sanitized visual control plane
- observability, eval, doctor, and release/privacy gates
- bus and blackboard protocol for multi-agent coding coordination
- sanitized NATS/JetStream signed-bus reference implementation
- durable production-safe JSONL blackboard ledger reference implementation
- synthetic memory demo for RAG, CAG preload, and compaction
- end-to-end trace model for user request to release decision
- sanitized Mission Control control-plane board schema and demo data
- Sentinel release-gate checklist and reviewer decision template
- Clean export manifest generation for release-gate prep
- Skill Forge registry and safe demo skill package
- Runtime operations templates for PM2, launchd, systemd, and safe health snapshots
- Fleet orchestration and specialist delegation registry
- Production-safe mock MCP/external integration adapter
- Fleet parity and SOUL/persona baseline checklist
- Production-safe Mermaid architecture diagrams
- TaskFlow/result-contract documentation for durable orchestration
- GitHub repository hygiene docs and sanitized community-template pack
- Security/governance lane (`FR-SECURITY-GOV-001`) for production-safe vault policy, no-public-secrets checks, quorum, approval gates, and incident deductions
- Goal operating system: `/goal` card format, lane receipts, fail-closed verifier, synthesis loop, and 30-minute operator update behavior
- Agent operating system: documented roles, launch path, coding-team execution path, cross-agent coordination model, and smoke/demo commands
- Remote approval/state parity: sanitized read-only approval requests, state snapshots, diff/test receipts, and reviewer decisions
- Self-healing recovery eval: stale blocker detection, owner/action classification, unsafe auto-fix refusal, and safe receipt-path retry loop

## Current status

Published production package with local verification gates. Future GitHub uploads or release artifacts remain separate approval actions and must bind the final candidate after verification.

This repository is intentionally documentation-first with runnable component demos under `src/*` and `examples/*`. The root `package.json` is a convenience entrypoint for clean-checkout install, demo, verification, and release artifact packaging.

## Download and run in 5 minutes

Prerequisite: Node.js 20 or newer. No external services, credentials, package installs, or private OpenClaw runtime state are required for the local demos.

```bash
git clone <repository-url> openclaw-frontier-stack
cd openclaw-frontier-stack
npm install --ignore-scripts
node scripts/check-environment.js
npm run demo
npm run verify
npm run release:pack
```

Expected result:

- `npm run demo` runs the goal-loop, coding-swarm, synthetic memory, and remote approval/state parity demos.
- `npm run verify` runs the production-safe verifier and writes `release-gate/reports/latest-verification.json`.
- `npm run release:pack` creates a downloadable npm tarball under `release-gate/artifacts/`.

If you are running from a downloaded tarball instead of Git, unpack it, enter the package directory, and run the same `npm run demo` and `npm run verify` commands.

## License

MIT License. See [LICENSE](LICENSE).

## What this is for

Engineers should be able to inspect and run synthetic demos showing how goals and coding agents coordinate safely:

1. Operator submits `/goal`.
2. Orchestrator creates a durable goal card and lane assignments.
3. Builder, Docs, Verifier, Release Manager, and Sentinel produce receipts.
4. Verifier fails closed on missing files, missing receipts, or failed checks.
5. Orchestrator synthesizes what shipped, what was verified, and what remains red.
6. In the coding swarm demo, Architect, Scout, Builder, Reviewer, and Sentinel coordinate through envelopes and blackboard claims.
7. Mission Control shows state, claims, tasks, and traceable results.

## Quick smoke path

```bash
npm run demo
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
- [Demo flow](docs/demo-flow.md)
- [Remote approval/state parity](docs/remote-approval-state-parity.md)
- [Security and governance](docs/security-governance.md)
- [Self-healing recovery eval](docs/evaluations/self-healing-recovery-eval.md)

## What this excludes

No live memories, transcripts, credentials, OAuth state, private hostnames/IPs/paths, client context, personal Telegram IDs, private automation context, raw logs, session DBs, vector stores, backups, or personal cron jobs.
