# Fleet parity and SOUL baseline

OpenClaw Frontier Stack assumes multiple agents and machines can participate in one coordinated fleet. Fleet parity means each participant has the minimum shared operating context needed to accept tasks, delegate safely, and return verifiable results.

## What must be consistent across the fleet

| Area | Baseline |
| --- | --- |
| Queue protocol | Task envelope, claim, result, readback, blocker states. |
| Specialist routing | Shared specialist registry and routing rules. |
| Release safety | Same public-release exclusions and human approval gates. |
| Tool access | Role-appropriate tool availability and documented limits. |
| Verification | Package verifier command, health snapshot shape, and evidence expectations. |
| Memory boundaries | No private memories/transcripts in public artifacts; cite durable board/wiki artifacts instead. |
| SOUL/persona files | Role identity, tone, safety boundaries, escalation rules, and task handoff behavior. |

## SOUL/persona completeness checklist

Each human-facing agent should have a role file or equivalent system context that covers:

- role and primary responsibility;
- preferred delegation behavior;
- when to stay quiet vs. speak in group;
- privacy and public-release exclusions;
- destructive/external action approval rules;
- how to produce `ITEM / PATH / COMMIT / VERIFY OUTPUT / NEEDS READBACK` claims;
- how to return `CONFIRMED / NOT VISIBLE / FAILED / BLOCKED` readbacks;
- escalation path when tools, repo state, or memory disagree;
- constraints for financial, legal, medical, or security-sensitive work;
- local machine capability notes without exposing private hostnames, IPs, paths, or tokens.

## Fleet audit artifact shape

```json
{
  "schema": "openclaw-frontier.fleet-parity-audit.v1",
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "agents": [
    {
      "id": "orchestrator",
      "role": "main coordinator",
      "queueProtocol": true,
      "specialistRegistry": true,
      "releaseExclusions": true,
      "verifierKnown": true,
      "soulBaseline": "complete",
      "blockers": []
    }
  ]
}
```

Use synthetic agent IDs in public packages. Keep real fleet inventories private unless explicitly approved for release.

## Drift handling

If one agent sees different repository state, tool access, or queue data:

1. Stop claiming completion.
2. Record `NOT VISIBLE` or `FAILED` with exact path/tool output.
3. Sync the canonical repo/board.
4. Re-run the verifier or readback.
5. Resume only after both orchestrator and reader agree on the artifact.
