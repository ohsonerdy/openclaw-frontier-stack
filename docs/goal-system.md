# Goal system

OpenClaw Frontier Stack treats a user goal as a durable operating primitive, not a chat message. A goal becomes a card, lanes, receipts, verification, synthesis, and operator updates.

## `/goal` card format

A goal card must include:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable goal id, e.g. `GOAL-FRONTIER-RELEASE-001`. |
| `status` | yes | `active`, `blocked`, `verify`, or `done`. Done means verified. |
| `owner` | yes | Usually `Orchestrator`. |
| `source` | yes | Operator channel, ticket, or local source. |
| `definitionOfDone` | yes | Concrete release bar. |
| `lanes` | yes | Implementation, docs, verification, packaging, final approval, or project-specific lanes. |
| `receipts` | yes | Paths to lane receipts. |
| `cadence` | yes | Operator update interval and destination. |
| `red` | yes | Blockers or unverifiable claims. Empty only when independently verified. |
| `green` | yes | Verified facts only. |

Minimal example:

```json
{
  "id": "GOAL-FRONTIER-RELEASE-001",
  "status": "active",
  "owner": "Orchestrator",
  "source": "operator-chat:/goal",
  "definitionOfDone": "Fresh clone can run the goal loop acceptance scenario and verifier fails closed.",
  "cadence": { "operatorUpdateMinutes": 30, "channel": "operator-chat" },
  "lanes": ["implementation", "documentation", "verification", "release-packaging", "final-approval"],
  "receipts": ["receipts/implementation.md", "receipts/verification.md"],
  "green": [],
  "red": ["No verifier receipt yet"]
}
```

## Receipts

Every lane returns a receipt with:

- lane name
- owner role
- start/end timestamp
- files changed or inspected
- commands run
- evidence paths
- verdict: `GREEN`, `RED`, or `BLOCKED`
- remaining risk

Receipts are source-of-truth for synthesis. The Orchestrator must not summarize a lane as green without a receipt or direct verifier evidence.

## Verifier loop

The verifier loop is fail-closed:

1. Load the goal card.
2. Confirm every required lane has a receipt path.
3. Confirm every receipt file exists.
4. Confirm every receipt has a verdict.
5. Run required smoke/smoke commands.
6. Mark missing files, missing commands, parse errors, stale exports, or failed checks as RED.
7. Emit a verification report.

No missing file may be treated as success.

## Synthesis loop

The Orchestrator synthesizes only from goal card + receipts + verifier report:

- what shipped
- what was verified
- what remains red
- what needs operator approval

The synthesis must not invent unverified work.

## 30-minute progress behavior

When a goal declares `operatorUpdateMinutes: 30`, the Orchestrator posts concise operator updates at that cadence until final decision:

- `GREEN`: verified progress since last update
- `RED`: blockers or failed checks
- `NEXT`: concrete next action

If no external chat integration is configured, the same update is written as a local receipt or status artifact so another surface can relay it.

## Acceptance scenario

Run:

```bash
node examples/goal-loop-acceptance scenario/run-goal-acceptance scenario.js
```

The acceptance scenario creates a synthetic goal card, lane receipts, fail-closed verification report, and final synthesis under `examples/goal-loop-acceptance scenario/out/`.
