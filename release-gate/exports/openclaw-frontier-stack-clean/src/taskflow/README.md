# TaskFlow runtime

Production-safe in-memory TaskFlow runtime for OpenClaw Frontier Stack demos and adapters.

It models durable orchestration events:

- task creation;
- task claim;
- wait states;
- blocked states;
- result completion with artifact references;
- snapshot reconstruction from the event stream.

The reference runtime is intentionally small, dependency-free, and local-only. Production deployments can persist the events through signed bus + blackboard storage.

## Run test

```bash
node src/taskflow/test/taskflow-local.test.js
```
