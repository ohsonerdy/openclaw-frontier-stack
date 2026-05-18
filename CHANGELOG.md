# Changelog

## 2026-05-18 - runtime supervisor guidance

### Changed

- Clarified that one-shot health checks should use a native scheduler or a
  persistent wrapper when process-manager state is treated as runtime health.
- Added PM2 template guidance to keep public ops examples free of misleading
  `stopped` service states.

All notable public-package changes should be recorded here. This changelog is for the operator-safe OpenClaw Frontier Stack package only; it must not reference private runtimes, personal context, raw logs, credentials, private hosts, or external announcements.

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
