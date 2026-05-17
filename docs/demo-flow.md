# Demo flow: coding swarm with shared state

This synthetic flow is the first runnable story the package should support.

## Actors

- **Orchestrator** — central coordinating role; owns the user request and final synthesis.
- **Architect** — decomposes implementation plan and risk assumptions.
- **Scout** — retrieves references from synthetic RAG/vector memory.
- **Builder** — claims files and implements the patch.
- **Reviewer** — checks correctness and maintainability.
- **Sentinel** — security/privacy/release gate.

## Flow

1. User asks Orchestrator to add a small feature to the demo app.
2. Orchestrator writes a TASK envelope for Architect.
3. Architect returns a plan RESULT with file targets.
4. Orchestrator creates Builder and Scout tasks.
5. Builder claims target paths on the blackboard before editing.
6. Scout cites synthetic memory/docs through RAG retrieval.
7. Builder emits a RESULT with patch/artifact path.
8. Reviewer validates the patch and emits FACT/RESULT.
9. Sentinel runs release/privacy gate and emits DECISION.
10. Orchestrator posts final human summary with trace links.
11. Mission Control displays task state, claims, results, and gate outcome.

## Evidence generated

- signed envelope log
- blackboard task/path claim log
- synthetic memory retrieval transcript
- result artifact path
- Sentinel release-gate decision
- end-to-end trace document

## Non-goals

- No real user data.
- No real external service credentials.
- No live private workspace paths.
- No public push from the demo itself.
