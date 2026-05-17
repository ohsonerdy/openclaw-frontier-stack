# Delegation router policy

Status: SHIP as a production-safe orchestration policy.

The delegation router is the component that decides whether an operator request should stay with the current agent, be delegated to another agent, be split into child tasks, or pause for operator approval. This policy is generic and does not include live endpoints, private rosters, credentials, chat identifiers, raw logs, or operator-private context.

## Inputs

A router may read only production-safe or local-runtime metadata:

- Request summary and requested outcome.
- Required capability tags.
- Candidate agent roster entries.
- Latest safe status source for each candidate.
- Risk tier and approval-required action classes.
- Estimated duration, need for tools, and whether the task can be parallelized.

## Decision order

1. **Safety gate:** If the request is destructive, external-facing, privacy-sensitive, credential-related, cost-impacting, or security-impacting, require explicit operator approval before action.
2. **Ownership match:** Prefer the agent whose roster entry owns the requested lane.
3. **Capability match:** Prefer agents with exact capability tags over generalists.
4. **Freshness check:** Prefer agents with recent healthy status; avoid stale or unreachable agents unless the task is explicitly diagnostic.
5. **Locality check:** Prefer the agent closest to the required files, runtime, or service.
6. **Parallel split:** If independent subtasks exist, split into child tasks with bounded scope and merge results before replying.
7. **Fallback:** If no candidate is safe and fresh, keep the task local or record a precise blocker.

## Output contract

A routing decision should be written as a small JSON object:

```json
{
  "schema": "openclaw-frontier.delegation-decision.v1",
  "request_id": "placeholder-request-id",
  "decision": "local|delegate|split|ask-approval|blocked",
  "selected_agents": ["agent-alpha"],
  "reason": "capability and ownership match",
  "risk_tier": "medium",
  "approval_required": false,
  "child_tasks": [],
  "blocker": null
}
```

## Non-goals

The router must not become a hidden authority system. It should not grant permissions, install keys, bypass approvals, mutate secrets, change exposure, publish externally, or make regulated-domain decisions on its own. It only recommends and dispatches within already-approved boundaries.
