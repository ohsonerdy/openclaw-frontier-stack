# Fleet orchestration and specialist delegation

OpenClaw Frontier Stack is designed for conductor agents that delegate work to specialist agents and tool backends instead of blocking the main chat/session.

## Pattern

```text
CHAT REQUEST
  -> orchestrator acknowledges
  -> task envelope created
  -> specialist selected
  -> work queued/delegated
  -> result artifact returned
  -> verifier/readback runs
  -> main chat receives concise status
```

Main chat agents should stay responsive. Heavy work belongs in queued workers, subagents, coding CLIs, local agents, or supervised task listeners.

## Specialist classes

| Class | Typical use | Gate |
| --- | --- | --- |
| Coding agent | Features, refactors, tests, package work | tests/build/verifier output |
| Security agent | config hardening, exposure review, auth changes | evidence + rollback plan |
| Research agent | web/source-backed synthesis | citations/source list |
| Legal agent | contract/policy review | non-lawyer disclaimer + source basis |
| Finance agent | budgets, business models, finance analysis | assumptions + no unauthorized trading |
| Marketing agent | positioning, copy, launch materials | audience + brand constraints |
| Commerce/local agent | eBay/card collection/simple local workflows | bounded scope + private-data filter |
| Reviewer/Sentinel | release gate, privacy scan, red-team review | explicit approve/block decision |

Some tasks should route to multiple specialists: e.g. coding + security for auth/config work, research + legal for policy-sensitive docs, marketing + sentinel for public release copy.

## Fleet parity requirements

Every machine/agent fleet should share a small baseline:

- current task queue protocol;
- claim/result/readback format;
- specialist registry;
- safe delegation rules;
- release/privacy exclusions;
- tested tool access appropriate to role;
- current SOUL/persona files for human-facing agents;
- local skills/tool notes for machine-specific capabilities;
- verifier command and health-check procedure.

Agent personality files do not need to be identical, but they must be complete enough for the role and must preserve the operator's constraints, privacy boundaries, and escalation rules.

## Minimal specialist registry shape

```json
{
  "schema": "openclaw-frontier.specialist-registry.v1",
  "specialists": [
    {
      "id": "coding-agent",
      "class": "coding",
      "runtime": "cli-or-subagent",
      "bestFor": ["implementation", "tests", "refactors"],
      "requires": ["repo path", "acceptance criteria"],
      "returns": ["diff", "test output", "blockers"]
    }
  ]
}
```

## Guardrails

- Do not delegate secret handling to public or weakly isolated agents.
- Do not let specialist output count as done until verifier/readback passes.
- Do not let multiple specialists edit the same path without a claim.
- Keep public release artifacts free of credentials, private memories, raw logs, private hostnames, and personal context.
- Preserve human approval for external publication, destructive changes, auth/provider changes, and legally/financially consequential actions.
