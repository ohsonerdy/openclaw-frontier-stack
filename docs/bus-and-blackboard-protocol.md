# Bus and blackboard protocol

This document maps the runnable local acceptance scenario to the production-grade architecture pattern without exposing any live private runtime data.

## Design goal

Coding swarms need two coordination planes:

1. **Bus** â€” signed messages between agents.
2. **Blackboard** â€” shared durable state for task ownership, path claims, and traceable work artifacts.

The bus answers: â€œWhat did an agent ask or report?â€
The blackboard answers: â€œWho owns what right now?â€

Together they prevent isolated chatbot behavior and file-stomping during parallel coding.

## Bus envelope types

The public framework defines these minimal envelope types (envelope schema `openclaw-frontier.envelope.v1`):

| Type | Purpose | Acceptance scenario example |
| --- | --- | --- |
| `TASK` | Delegate work with a result contract. | Orchestrator asks Builder to create a patch artifact. |
| `RESULT` | Return completed work and artifacts. | Builder returns patch path and digest. |
| `FACT` | Publish verified state. | Reviewer records â€œpatch has no external IO.â€ |
| `OBSERVATION` | Publish un-validated state. Non-human-facing; intended for telemetry/observability streams that have not yet been promoted to `FACT`. | Scout records â€œqueue depth is 17â€ without verification. |
| `DECISION` | Record an approval/blocking decision. | Sentinel emits `APPROVE_RELEASE_CANDIDATE`. |
| `ALERT` | Human-safe operational signal. | Sentinel warns a release gate is blocked. |
| `HEARTBEAT` | Liveness/presence signal. | Agents advertise current status. |

### `OBSERVATION` vs `FACT`

`OBSERVATION` carries un-validated state; `FACT` carries verified state. A
reviewer or sentinel typically promotes an `OBSERVATION` to a `FACT` after the
underlying claim is verified. Subscribers that care only about durable truth
should subscribe to `FACT.*`; subscribers building dashboards or anomaly
detection over raw signal should subscribe to `OBSERVATION.*`.

This is the closed set. Adding a new envelope type is a breaking change to
`openclaw-frontier.envelope.v1` and requires a schema version bump.

## Required envelope fields

```json
{
  "id": "task-1",
  "type": "TASK",
  "from": "orchestrator",
  "to": "builder",
  "correlationId": "task-root",
  "ts": "2026-01-01T00:00:00.000Z",
  "body": {
    "summary": "Create synthetic patch artifact",
    "expectedResult": ["artifact path", "digest", "notes"]
  },
  "signature": "acceptance scenario-signature"
}
```

Production implementations should sign the canonical payload with an agent-specific key. The acceptance scenario uses a fake local HMAC key only to show the shape.

## Blackboard records

The blackboard must track at least:

### Task claim

```json
{
  "kind": "task-claim",
  "agent": "builder",
  "taskId": "task-6",
  "summary": "Create synthetic patch artifact",
  "claimedAt": "2026-01-01T00:00:00.000Z"
}
```

### Path claim

```json
{
  "kind": "path-claim",
  "agent": "builder",
  "taskId": "task-6",
  "path": "src/acceptance scenario-app.js",
  "claimedAt": "2026-01-01T00:00:00.000Z"
}
```

### Task completion

```json
{
  "kind": "task-done",
  "taskId": "task-6",
  "artifact": "out/acceptance scenario-health-endpoint.patch",
  "finishedAt": "2026-01-01T00:00:00.000Z"
}
```

## JSONL ledger API

The package includes a production-safe production implementation at `src/blackboard/`.

The ledger is append-only JSONL and records:

| API | Record kind | Purpose |
| --- | --- | --- |
| `claimTask` | `task-claim` | Mark an agent as owner for a task. |
| `claimPath` | `path-claim` | Reserve a workspace-relative path before editing. |
| `releasePath` | `path-release` | Release a path after work or review completes. |
| `recordFact` | `fact` | Store verified state with optional evidence references. |
| `recordDecision` | `decision` | Store release, review, or routing decisions. |
| `recordResult` | `result` | Store task outcome summaries and artifact references. |

Path claims are validated before append: paths must be relative, cannot contain parent-directory segments, cannot be absolute paths or URLs, and cannot use secret-like segment names.

## Concurrency rule

Before modifying a shared file, an agent must claim the path. A second agent attempting to claim the same path must stop, negotiate, or wait.

This is what makes the framework suitable for coding swarms instead of independent coding bots.

## Acceptance scenario-to-production mapping

| Acceptance scenario component | Production equivalent |
| --- | --- |
| `examples/demo-swarm/run-demo.js` in-memory bus | NATS/squad-bus transport |
| fake HMAC signature | agent Ed25519 signature |
| in-memory blackboard object | `src/blackboard` JSONL ledger or SQLite-backed equivalent |
| synthetic memory array | RAG/vector/session memory index |
| local patch file | real reviewed artifact path |
| `APPROVE_RELEASE_CANDIDATE` | Sentinel release/privacy decision |

## Safety rules

- Never put secrets in envelopes.
- Never include raw private transcripts or memory dumps in bus payloads.
- Use artifact references instead of large payload bodies.
- Human-facing alerts must summarize impact and action; do not dump raw JSON into chat.
- Release decisions must distinguish acceptance scenario approval from public upload approval.

## Verification checklist

A GitHub-ready package should acceptance scenarionstrate:

- at least one TASKâ†’RESULT chain;
- at least one path claim before a patch artifact;
- at least one reviewer RESULT;
- at least one Sentinel DECISION;
- a trace artifact linking all of the above;
- a safety statement that no external push/publish occurred;
- envelope `type` enum exactly matches: `TASK`, `RESULT`, `FACT`, `OBSERVATION`, `DECISION`, `ALERT`, `HEARTBEAT`.
