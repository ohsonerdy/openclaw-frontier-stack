# Mission Control control plane

Mission Control is the visual sidecar for OpenClaw Frontier Stack. It makes the agent swarm legible to engineers and operators without becoming the source of truth.

## Principle

Mission Control is a **readable control plane**, not the authority.

Source of truth remains:

- signed bus envelopes;
- blackboard task/path claims;
- memory/retrieval artifacts;
- result contracts;
- Sentinel decisions.

Mission Control should display and optionally propose changes, but writeback starts as dry-run intent until a reviewer approves it.

## What the public package ships

SHIP/SANITIZE:

- UI shell concept and data model;
- synthetic board data;
- adapter docs for converting bus/blackboard state into cards;
- dry-run writeback intent shape;
- demo card set for Orchestrator, Architect, Scout, Builder, Reviewer, Sentinel.

EXCLUDE:

- live chat history;
- personal/person directory;
- private mission files;
- real hostnames, paths, IPs, or account IDs;
- real memory/session payloads;
- private runtime logs;
- automatic mutation of source-of-truth systems.

## Board schema

```json
{
  "schema": "openclaw-frontier.mission-control-board.v1",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "lanes": [
    { "id": "planned", "title": "Planned" },
    { "id": "active", "title": "Active" },
    { "id": "review", "title": "Review" },
    { "id": "gated", "title": "Gated" },
    { "id": "done", "title": "Done" }
  ],
  "cards": [
    {
      "id": "card-builder-health-endpoint",
      "lane": "active",
      "title": "Builder: demo health endpoint",
      "owner": "builder",
      "taskId": "task-6",
      "claims": ["src/demo-app.js"],
      "artifacts": ["out/demo-health-endpoint.patch"],
      "status": "done"
    }
  ]
}
```

## Dry-run writeback intent

Mission Control may produce an intent object instead of directly mutating the bus/blackboard:

```json
{
  "kind": "dry-run-writeback-intent",
  "actor": "operator",
  "action": "move-card",
  "cardId": "card-builder-health-endpoint",
  "fromLane": "active",
  "toLane": "review",
  "wouldEmit": {
    "type": "DECISION",
    "from": "operator",
    "to": "orchestrator",
    "body": { "summary": "Move builder card to review." }
  },
  "requiresApproval": true
}
```

## Demo story

1. Orchestrator decomposes the request.
2. Architect, Scout, Builder, Reviewer, and Sentinel cards appear on the board.
3. Builder card shows a path claim before patch artifact.
4. Reviewer card links to review RESULT.
5. Sentinel card links to release/privacy DECISION.
6. Orchestrator card summarizes final trace.
7. Operator can drag a card, but the system emits only a dry-run writeback intent.

## GitHub readiness requirement

Before public release, Mission Control materials must use only synthetic demo data and pass the release gate. Any real board export must be rejected unless it is transformed and scanned into this schema with private fields removed.
