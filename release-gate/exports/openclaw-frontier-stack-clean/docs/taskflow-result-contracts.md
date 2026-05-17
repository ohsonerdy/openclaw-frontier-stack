# TaskFlow and result contracts

TaskFlow is the durable orchestration layer for OpenClaw Frontier Stack. It turns one user request into linked child tasks with explicit state, waits, artifacts, and review gates.

## Why this matters

Coding swarms fail when agents only chat. They need durable work units:

- who owns the task;
- what output is required;
- what artifact proves completion;
- what is blocked;
- who reviewed it;
- whether Sentinel allows release.

## Task lifecycle

```text
created -> claimed -> running -> waiting|blocked|done|failed -> reviewed -> gated
```

A task can wait on a person, child agent, external system, or release gate. Waiting is a first-class state, not a forgotten chat message.

## Minimal task record

```json
{
  "taskId": "task-builder-001",
  "owner": "builder",
  "parentTaskId": "task-root-001",
  "status": "running",
  "summary": "Implement demo health endpoint",
  "resultContract": {
    "required": ["summary", "artifact", "verification", "blockers"],
    "artifactTypes": ["patch", "test-output", "trace"]
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

## Result contract

Every non-trivial TASK must end with a RESULT or an explicit blocker.

```json
{
  "taskId": "task-builder-001",
  "type": "RESULT",
  "from": "builder",
  "summary": "Added synthetic health endpoint patch.",
  "artifacts": [
    {
      "path": "out/demo-health-endpoint.patch",
      "sha256": "...",
      "kind": "patch"
    }
  ],
  "verification": [
    {
      "command": "node examples/demo-swarm/run-demo.js",
      "ok": true,
      "summary": "12 envelopes, 6 tasks, 1 path claim"
    }
  ],
  "blockers": []
}
```

## Blocker contract

A blocker must be exact and actionable.

```json
{
  "taskId": "task-sentinel-001",
  "type": "BLOCKER",
  "from": "sentinel",
  "blockedOn": "missing-reviewer-approval",
  "neededFrom": "reviewer",
  "safeToRetry": true,
  "details": "Reviewer RESULT is missing for artifact out/demo-health-endpoint.patch."
}
```

Do not use vague blockers like “still working” or “system unstable” without an observed failing command or missing input.

## Parent orchestration

Orchestrator owns the parent request and links child work:

```text
root TASK
├─ Architect TASK -> RESULT(plan)
├─ Scout TASK -> RESULT(memory hits)
├─ Builder TASK -> RESULT(patch artifact)
├─ Reviewer TASK -> RESULT(review)
└─ Sentinel TASK -> DECISION(release gate)
```

Orchestrator may summarize only after required child results are complete or explicitly blocked.

## Review gates

- Reviewer validates correctness and maintainability.
- Sentinel validates privacy/security/release safety.
- Owner approval is distinct from Sentinel approval.
- production-ready approval is not public upload approval.

## Retry and idempotency

Tasks should be safe to retry when possible. Result artifacts need stable ids or content hashes. If a retry would mutate shared state, the agent must re-check blackboard path claims.

## Public package requirement

The GitHub-ready package must include at least one runnable flow that demonstrates:

- parent task;
- child tasks;
- result contracts;
- explicit artifact path;
- verification summary;
- reviewer result;
- Sentinel decision;
- final Orchestrator synthesis.

The demo-swarm example currently satisfies the first runnable version of this requirement.
