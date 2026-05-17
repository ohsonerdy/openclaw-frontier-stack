# Demo swarm example

Synthetic local-only demo for the OpenClaw Frontier Stack.

It demonstrates the minimum full-stack story without private data or external services:

- Orchestrator receives a root TASK.
- Architect returns a plan RESULT.
- Scout retrieves synthetic memory/RAG context.
- Builder claims a path before producing a patch artifact.
- Reviewer validates the artifact.
- Sentinel emits a release/privacy DECISION.
- Orchestrator returns a final RESULT with traceable artifacts.

Run:

```bash
node examples/demo-swarm/run-demo.js
```

Generated outputs live under `examples/demo-swarm/out/` and are ignored by git:

- `trace.json`
- `summary.md`
- `demo-health-endpoint.patch`

This demo intentionally uses fake local data, a demo signing key, and no network calls.
It is not a GitHub publish approval path.
