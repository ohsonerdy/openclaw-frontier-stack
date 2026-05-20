# Mission Control demo data

Synthetic board data for the OpenClaw Frontier Stack control-plane story.

Files:

- `board.json` — fake Mission Control board with Orchestrator, Architect, Scout, Builder, Reviewer, and Sentinel cards.
- `writeback-intent.example.json` — dry-run-only operator intent shape.

This is not a live board export. It contains no private messages, people directory, hostnames, account IDs, memory payloads, or session data.

Mission Control must remain a sidecar: source of truth stays in bus envelopes, blackboard claims, result artifacts, and Sentinel decisions.
