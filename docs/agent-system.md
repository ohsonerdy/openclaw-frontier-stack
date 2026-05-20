# Agent system

OpenClaw Frontier Stack models an engineering squad as role agents coordinated by an **Orchestrator**. Private deployments can map these roles onto local operators or bots, but the public release architecture uses generic role labels only.

## Core roles

| Role | Responsibility | Writes? | Required receipt |
| --- | --- | --- | --- |
| Orchestrator | Owns the goal card, assigns lanes, tracks cadence, synthesizes final state. | Coordination artifacts only unless explicitly assigned. | Final synthesis. |
| Architect | Designs boundaries, plans task decomposition, identifies risks. | Docs/plans. | Architecture receipt. |
| Builder | Implements code/config/docs changes inside claimed paths. | Yes, internal reversible writes. | Implementation receipt. |
| Docs | Produces engineer-facing setup, operation, and smoke-path docs. | Docs. | Documentation receipt. |
| Verifier | Runs tests, smoke acceptance scenarios, and fail-closed file checks. | Reports only. | Verification receipt. |
| Sentinel | Reviews privacy, safety, secrets, and release authority. | Reports/gates only. | Security/release gate receipt. |
| Release Manager | Builds release manifest, manifest, release notes, and packaging packet. | Release artifacts. | Packaging receipt. |

## Launch/setup instructions

1. Clone or unpack the repository.
2. Read `README.md`, `docs/goal-system.md`, and this file.
3. Run the production smoke path:

```bash
node examples/goal-loop-demo/run-goal-demo.js
node examples/demo-swarm/run-demo.js
node scripts/verify-package.js
```

4. Inspect generated reports:

```text
examples/goal-loop-demo/out/verification-report.json
examples/goal-loop-demo/out/final-synthesis.md
release-gate/reports/latest-verification.json
```

## Coding-team execution path

1. Operator submits `/goal`.
2. Orchestrator creates or updates the goal card.
3. Orchestrator assigns bounded lanes.
4. Builder claims paths before edits.
5. Docs updates setup and usage docs.
6. Verifier runs smoke and package checks.
7. Sentinel reviews release safety and publication authority.
8. Release Manager creates release manifest / release packet.
9. Orchestrator synthesizes exactly what shipped, what was verified, and what remains red.

## Cross-agent coordination model

Agents coordinate through durable artifacts, not vibes:

- signed bus envelopes for delegated tasks/results
- blackboard path/task claims for concurrent work
- goal cards for operator intent
- receipts for lane evidence
- verifier reports for release truth
- Mission Control or equivalent UI as a view, not the source of truth

## Verifier behavior

Verifier must fail closed on:

- missing goal card
- missing receipt path
- missing receipt file
- missing verdict
- stale or ungenerated release manifest
- failed smoke/acceptance scenario command
- private-content scanner hit
- unbound final approval for external/public release

## Production smoke/acceptance scenario path

The release ships two local-only smoke paths:

- `examples/goal-loop-demo/run-goal-demo.js` proves `/goal` card → receipts → verifier → synthesis.
- `examples/demo-swarm/run-demo.js` proves Orchestrator → Architect/Scout/Builder/Reviewer/Sentinel coordination.

Both are synthetic and local-only. They do not require credentials or external services.
