# Memory demo

Synthetic local-only demo for the OpenClaw Frontier Stack memory layer.

It demonstrates:

- small durable memory corpus;
- toy semantic retrieval over sanitized text;
- CAG preload generation with deterministic ordering and hash;
- compaction of a noisy task trace;
- promotion filtering that accepts durable decisions/artifacts and rejects filler.

Run:

```bash
node examples/memory-demo/run-memory-demo.js
```

Generated outputs live under `examples/memory-demo/out/` and are ignored by git:

- `memory-demo-result.json`
- `CAG-PRELOAD.example.md`
- `summary.md`

The demo performs zero network calls and uses no private runtime data.
