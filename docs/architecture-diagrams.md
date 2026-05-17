# Architecture diagrams

These diagrams are production-safe conceptual maps for OpenClaw Frontier Stack. They use synthetic component names only and avoid private hostnames, paths, IPs, credentials, raw logs, and personal context.

## Full-stack overview

```mermaid
flowchart TB
  Human[Human operator] --> Chat[Main chat agents]
  Chat --> Orchestrator[Orchestrator agent]
  Orchestrator --> Queue[Task queue / signed envelopes]
  Queue --> Blackboard[Blackboard: claims, facts, decisions]
  Queue --> Coding[Coding specialists]
  Queue --> Security[Security reviewers]
  Queue --> Research[Research specialists]
  Queue --> Domain[Domain specialists]
  Coding --> Artifacts[Artifacts: code, docs, tests]
  Security --> Artifacts
  Research --> Artifacts
  Domain --> Artifacts
  Artifacts --> Verifier[Package verifier + release gate]
  Verifier --> Result[RESULT envelope + readback]
  Result --> Chat
  Blackboard --> Mission[Mission Control sidecar]
  Mission --> Intent[Dry-run writeback intent]
  Intent --> Queue
```

## Request-to-result flow

```mermaid
sequenceDiagram
  participant H as Human
  participant C as Main chat agent
  participant O as Orchestrator
  participant Q as Queue / signed bus
  participant W as Specialist worker
  participant V as Verifier
  participant R as Readback agent

  H->>C: Request or correction
  C->>O: Summarize task + constraints
  O->>Q: Create TASK envelope
  Q->>W: Assign bounded work
  W->>Q: CLAIM path / scope
  W->>Q: RESULT with artifact paths
  Q->>V: Run verifier or release gate
  V->>Q: Verification artifact
  Q->>R: Request cross-agent readback
  R->>Q: CONFIRMED / FAILED / BLOCKED
  O->>C: Concise status + next action
  C->>H: Human-facing update
```

## Memory/RAG/CAG/compaction flow

```mermaid
flowchart LR
  Source[Source artifacts] --> Filter[Promotion filter]
  Filter --> Durable[Durable notes / docs]
  Durable --> Index[Vector/RAG index adapter]
  Durable --> Cache[CAG preload cache]
  Index --> Retrieval[Task-scoped retrieval]
  Cache --> Retrieval
  Retrieval --> Worker[Specialist worker]
  Worker --> Output[Result artifact]
  Output --> Compact[Compaction summary]
  Compact --> Filter
```

## Release gate flow

```mermaid
flowchart TB
  Candidate[Clean package candidate] --> Verify[Package verifier]
  Verify --> Scan[Private-content scan]
  Scan --> Reviewers[4/4 reviewer decisions]
  Reviewers --> Decision{All approve?}
  Decision -- no --> Block[BLOCK with reasons]
  Decision -- yes --> the operator[the operator explicit approval]
  the operator --> Publish[External publish step]
  Block --> Fix[Fix artifacts]
  Fix --> Candidate
```

## Diagram status

- Full-stack overview: ready for README or docs.
- Request-to-result flow: captures delegate-first queue pattern.
- Memory flow: conceptual until real RAG/CAG adapters are packaged.
- Release gate flow: conceptual until 4/4 decision artifacts exist.
