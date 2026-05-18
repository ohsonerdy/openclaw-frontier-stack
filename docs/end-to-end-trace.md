# End-to-end trace model

A frontier agent framework must prove what happened. This trace model connects the user request, bus envelopes, blackboard state, memory retrieval, artifacts, and release decision.

## Trace stages

1. **Ingress** — user request enters Orchestrator.
2. **Planning** — Architect produces a plan.
3. **Retrieval** — Scout or Orchestrator cites memory/RAG hits.
4. **Claim** — Builder claims paths before edits.
5. **Artifact** — Builder writes patch or output artifact.
6. **Review** — Reviewer validates artifact.
7. **Gate** — Sentinel emits DECISION.
8. **Synthesis** — Orchestrator replies with human summary and evidence links.

## Trace record shape

```json
{
  "traceId": "trace-acceptance scenario-001",
  "rootTaskId": "task-1",
  "userRequest": "Add a visible health endpoint to the acceptance scenario app.",
  "envelopes": ["task-1", "task-2", "result-3"],
  "blackboardEvents": ["task-claim", "path-claim", "task-done"],
  "memoryHits": ["mem-001"],
  "artifacts": ["out/acceptance scenario-health-endpoint.patch"],
  "reviews": ["review-pass"],
  "decisions": ["APPROVE_RELEASE_CANDIDATE"],
  "finalSummary": "Synthetic coding swarm completed with traceable artifacts."
}
```

## What must be traceable

- Which agent did the work.
- Which task authorized the work.
- Which paths were claimed.
- Which artifacts were produced.
- Which command or check verified the artifact.
- Which reviewer/gate approved or blocked.
- Whether any public upload occurred. For acceptance scenarios, this must be `false`.

## What must not be included

- raw private transcripts;
- live session DB excerpts;
- private memory payloads;
- credentials or tokens;
- private hostnames/IPs/paths;
- client or personal context.

## MCP/tool-call trajectories

MCP-shaped integrations add a narrower trajectory beneath the end-to-end trace. `src/integration-adapters/lib/mock-mcp-adapter.js` includes a production-safe `ToolTrajectoryLog` that records tool-call sequence, status, latency, operator-safe artifact references, and a reliability score. It stores input/result shapes plus SHA-256 digests instead of raw payloads, and rejects URLs, IPs, home paths, private keys, and common token formats before exporting trajectory data.

Use this for reference-package evidence such as: "the acceptance scenario adapter called `knowledge.search`, then `artifact.summarize`, both succeeded, both returned synthetic artifacts, reliability scored high." Do not use it as a raw production transcript dump.

## Acceptance scenario artifacts

`examples/acceptance scenario-swarm/run-acceptance scenario.js` produces:

- `out/trace.json` — envelope + blackboard trace;
- `out/summary.md` — human-readable summary;
- `out/acceptance scenario-health-endpoint.patch` — synthetic patch artifact.

`examples/memory-acceptance scenario/run-memory-acceptance scenario.js` produces:

- `out/memory-acceptance scenario-result.json` — retrieval/CAG/compaction result;
- `out/CAG-PRELOAD.example.md` — synthetic CAG preload;
- `out/summary.md` — memory-layer summary.

Generated `out/` directories are intentionally ignored by git. Reviewers should run the acceptance scenarios locally and inspect generated artifacts.

## GitHub readiness gate

Before public upload, the release packet must include:

- trace acceptance scenario verification output;
- memory acceptance scenario verification output;
- scanner output;
- 4/4 review decisions;
- explicit owner upload approval.
