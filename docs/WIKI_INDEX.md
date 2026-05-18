# OpenClaw Frontier Stack wiki index

Status: SHIP as the public documentation map.

This index is the recommended starting point for maintainers reviewing or uploading the OpenClaw Frontier Stack package. It links the production-safe docs tree into a coherent path from concept to verification. The package remains a production package with private runtime state excluded, not a private runtime export.

## Start here

1. [README](../README.md) — package purpose, status, exclusions, and quick acceptance scenario entry points.
2. [Release scope](release-scope.md) — what belongs in the public package and what stays private.
3. [Public release boundaries](public-release-boundaries.md) — allowed content, excluded content, placeholders, and pre-upload checks.
4. [Security and governance](security-governance.md) — production-safe vault policy, no-public-secrets guard, quorum, approval gates, and incident scoring.
5. [Maintainer handoff](maintainer-handoff.md) — how a new maintainer should inspect, verify, and continue the package.

## Architecture

- [Goal system](goal-system.md) — `/goal` card format, receipts, verifier loop, synthesis loop, and 30-minute operator update behavior.
- [Agent system](agent-system.md) — Orchestrator-led roles, setup, coding-team execution path, verifier behavior, and smoke/acceptance scenario path.
- [Architecture diagrams](architecture-diagrams.md) — production-safe Mermaid diagrams for the stack.
- [Bus and blackboard protocol](bus-and-blackboard-protocol.md) — signed coordination and ledger model.
- [Fleet orchestration](fleet-orchestration.md) — multi-agent coordination model.
- [Agent roster manifest](agent-roster-manifest.md) — shared manifest shape for ownership, roles, capabilities, risk, and status sources.
- [Delegation router policy](delegation-router-policy.md) — safety-first routing from request to local work, delegation, split tasks, approval, or blocker.
- [TaskFlow result contracts](taskflow-result-contracts.md) — durable task/result envelope expectations.
- [Mission Control control plane](mission-control-control-plane.md) — operator-safe dashboard/control-plane model.

## Runtime subsystems

- [Runtime ops](runtime-ops.md) — safe runtime/service templates and health snapshots.
- [Memory / RAG / CAG / compaction](memory-rag-cag-compaction.md) — memory architecture and local acceptance scenario flow.
- [Skill Forge](skill-forge.md) — safe skill registry and acceptance scenario package shape.
- [Integration adapters](../src/integration-adapters/README.md) — production-safe local test adapter boundary.
- [Bus connectivity diagnostics](bus-connectivity-diagnostics.md) — diagnosing publisher, transport, verification, and contract mismatch failures.
- [Communication planes setup](communication-planes.md) — Telegram, Discord, and Slack setup patterns for human-facing agent coordination.
- [Graph system](graph-system.md) — portable node/edge model for capabilities, tasks, artifacts, reviews, releases, and communication planes.

## Acceptance scenarios and examples

- [Verification flow](verification-flow.md) — synthetic user request to coordinated swarm acceptance scenario.
- [End-to-end trace](end-to-end-trace.md) — request-to-release evidence flow.
- [Goal loop acceptance scenario](../examples/goal-loop-demo/README.md) — local synthetic `/goal` card → receipts → verifier → synthesis loop.
- [Acceptance scenario swarm example](../examples/demo-swarm/README.md) — local synthetic multi-agent coordination.
- [Memory acceptance scenario](../examples/memory-demo/README.md) — synthetic memory/RAG/CAG acceptance scenario.
- [Mission Control acceptance scenario](../examples/mission-control-demo/README.md) — operator-safe board and writeback-intent example.

## Release gate

- [Checklist](../release-gate/checklist.md) — upload-readiness checklist.
- [Reviewer decision schema](../release-gate/reviewer-decision-schema.md) — reviewer decision file contract.
- [GitHub repository hygiene](github-repository-hygiene.md) — community/security/repository template expectations.
- [Supply-chain security](supply-chain-security.md) — dependency and release safety notes.
- [Security and governance](security-governance.md) — `FR-SECURITY-GOV-001` eval/acceptance scenario/spec for vault placeholders, no-public-secrets scanning, quorum, approval gates, and incident deductions.
- [Fresh clone verification](fresh-clone-verification.md) — release manifest/fresh clone verification model.

## Upload blockers

The package must not be uploaded until all release-gate blockers are cleared:

- Required reviewer decisions are present.
- Root license is selected and added.
- Latest verifier report is passing.
- Release manifest was regenerated after the last content change.
- Operator upload approval is explicitly recorded.

## Maintenance rule

Add new public docs to this index when they introduce a new subsystem, release gate, runbook, or template family. Do not add private operational logs, secrets, live endpoints, private paths, personal context, raw databases, memory dumps, vector stores, backups, or out-of-scope domain systems.
