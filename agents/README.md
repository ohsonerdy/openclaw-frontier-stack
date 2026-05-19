# OpenClaw Frontier Stack agent roster

This directory holds the role contracts the orchestration harness dispatches against.
Each role is a narrow lane with explicit decision authority, hard preconditions, and
forbidden paths. The contracts are agent-host-neutral — they work whether the
underlying agent runs in Claude Code, Codex, Cursor, OpenCode, or any other
runtime that supports the Agent Skills specification.

These are not marketing skills. They are internal-coordination prompts.
The packaged `skills/` tree at the repo root is the public surface; this
`agents/` tree is the coordination contract layer that drives the swarm.

## Roster

| Role | Lane | Can ship public? |
| --- | --- | --- |
| `orchestrator` | Decomposes goals into lanes, dispatches, collects receipts, synthesizes. | No — dispatch only. |
| `security-sentinel` | Public-release gate. Issues `PROPOSE_RELEASE`. | Proposes only — operator counter-signs. |
| `architect` | Owns release-gate code, workflows, plugin manifests, harness shape. | No — writes architect decisions only. |
| `builder` | Writes feature code under non-gated paths. | No — bot identity required for any commit. |
| `reviewer` | Gates PRs against repo conventions. | No — cannot approve own PRs. |
| `researcher` | Investigates open questions, surfaces facts. | No — facts only, no code. |
| `marketing-strategist` | Drives the Modern Skills product roadmap. | No — briefs only, builder authors. |
| `executive-summary` | Produces operator-facing rollups. | No — summarizes, never decides. |

## When each role activates

- **orchestrator** — first responder to any `/goal` envelope on the signed bus.
- **security-sentinel** — activated by the orchestrator when a candidate
  release manifest has been built; also reacts to any `ALERT` envelope tagged
  `release-gate`.
- **architect** — activated when any task touches the protected paths
  enumerated in its contract, or when the orchestrator surfaces a structural
  question (schema bump, new envelope type, FSM state change).
- **builder** — activated by `TASK` envelopes carrying `class: implementation`
  or `class: fix`.
- **reviewer** — activated when a builder posts a `RESULT` envelope citing
  artifacts in a PR-staged branch, before sentinel-gate runs.
- **researcher** — activated when any role posts an `OBSERVATION` envelope
  with `subject: open-question`, or by an explicit dispatch.
- **marketing-strategist** — activated on a cadence by `executive-summary`
  rollups indicating drift in the Modern Skills set, or by explicit
  `/skills-roadmap` requests from the operator.
- **executive-summary** — runs on a fixed cadence (daily/weekly), reads the
  blackboard plus recent receipts, writes a summary fact. Also dispatchable
  on demand.

## Coordination plane

All roles read and write to the shared blackboard ledger
(`src/blackboard/lib/ledger.js`) and emit signed envelopes over the bus
(`src/signed-bus/lib/envelope.js`). Tasks flow through the FSM in
`src/taskflow/lib/taskflow.js` with states `queued / claimed / waiting /
done / failed / blocked`.

Every role must:

1. Read its CONTRACT.md every turn — the contract is the prompt.
2. Pass its hard preconditions before acting.
3. Emit a single signed envelope per turn with the ack shape its contract
   specifies.
4. Append the corresponding blackboard record (task-claim, fact, decision,
   or result) when the envelope type is one the blackboard accepts.

## Separation of powers

- The orchestrator dispatches. It does not approve releases, gate PRs, or
  write to release-gate code.
- The security-sentinel proposes releases. It does not counter-sign its own
  proposals — the operator does that out of band.
- The architect owns the shape of the harness. It does not write feature
  code or approve PRs.
- The builder writes feature code. It does not edit release-gate code,
  workflows, or plugin manifests.
- The reviewer reads diffs against the conventions. It does not approve
  PRs it authored.
- The researcher reads and writes facts. It does not write code.
- The marketing-strategist proposes. It does not author skills.
- The executive-summary summarizes. It makes no decisions.

A role that catches itself drifting into another lane MUST stop, emit an
`ALERT` envelope tagged `out-of-lane`, and yield to the correct role.

## File layout

```
agents/
  README.md                       <- this file
  orchestrator/CONTRACT.md
  security-sentinel/CONTRACT.md
  architect/CONTRACT.md
  builder/CONTRACT.md
  reviewer/CONTRACT.md
  researcher/CONTRACT.md
  marketing-strategist/CONTRACT.md
  executive-summary/CONTRACT.md
```

## Contract format

Every CONTRACT.md follows the same nine-section shape:

1. Mission
2. Hard preconditions (must check before acting)
3. Decision authority (Can / Cannot)
4. Inputs you receive
5. Outputs you produce
6. Ack format
7. What you must NEVER do
8. Failure modes (BLOCK vs FAIL vs WAIT)
9. Done state

Read the role contract end-to-end before your first action of each turn.
The contract is the prompt — every clause is load-bearing.
