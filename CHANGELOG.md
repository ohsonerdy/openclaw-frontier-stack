# Changelog

All notable public-package changes should be recorded here. This changelog is for the sanitized OpenClaw Frontier Stack package only; it must not reference private runtimes, personal context, raw logs, credentials, private hosts, or external announcements.

## 2026-05-17 — production release

Status: published production release after verification, reviewer approvals, license selection, and explicit owner upload approval.

### Added

- Clean architecture package README, release scope, demo flow, and architecture diagrams.
- Synthetic demo swarm showing Orchestrator, Architect, Scout, Builder, Reviewer, and Sentinel coordination.
- Signed bus envelope helpers and local verification tests.
- JSONL blackboard reference implementation with task, path, fact, decision, and result records.
- TaskFlow reference runtime for durable task orchestration.
- Memory adapter examples for RAG, CAG preload, compaction, and promotion filtering.
- Skill Forge demo registry and safe read-only demo skill.
- Mock external integration adapter.
- Mission Control sidecar demo data and dry-run writeback intent.
- Runtime operations templates for common supervisors and health snapshots.
- GitHub hygiene templates for contribution, security, issue, and pull request workflows.
- Release-gate artifacts for reviewer decisions, evidence index, release notes, license selection, clean export, and export parity checks.
- Goal operating system docs and local demo for `/goal` card, lane receipts, fail-closed verifier, synthesis, and 30-minute operator updates.
- Agent operating system docs covering Orchestrator-led roles, coding-team execution path, cross-agent coordination, setup, and production smoke/demo path.
- Public architecture naming uses generic role labels only; private deployment personas are intentionally out of scope for the public package.

### Verification

- Run `node examples/goal-loop-demo/run-goal-demo.js` from the package root.
- Run `node scripts/verify-package.js` from the package root.
- Run `node scripts/verify-package.js` before any future release decision.
- Current expected release status is published for the production release; future release candidates must pass reviewer, license, and owner upload gates before publication.

### Publication status

This package was approved by the owner for GitHub upload and production release after the production-safe verifier, reviewer matrix, license gate, and upload approval gates passed. Future public releases require the same gate sequence and explicit owner approval.
