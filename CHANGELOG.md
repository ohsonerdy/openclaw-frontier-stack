# Changelog

All notable public-package changes should be recorded here. This changelog is for the operator-safe OpenClaw Frontier Stack package only; it must not reference private runtimes, personal context, raw logs, credentials, private hosts, or external announcements.

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
