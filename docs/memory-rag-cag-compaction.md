# Memory, RAG, CAG, and compaction architecture

This document describes the production-safe memory architecture for OpenClaw Frontier Stack. It uses local acceptance scenarios only.

## Design goal

Coding swarms need durable memory without dumping every prior turn into every prompt. The stack separates memory into layers so agents can retrieve the right context at the right cost.

## Layers

| Layer | Purpose | Public package shape |
| --- | --- | --- |
| Session trace | Raw turn/tool history for debugging. | Synthetic trace examples only; no live transcripts. |
| Working memory | Current task state and recent decisions. | Acceptance scenario JSON/Markdown artifacts. |
| Durable memory | Stable facts, decisions, patterns, and runbooks. | Synthetic Markdown corpus. |
| Vector/RAG index | Semantic retrieval over durable docs. | Local deterministic local index in acceptance scenario script. |
| CAG preload | Compiled high-value context loaded in stable order. | Synthetic `CAG-PRELOAD.example.md`. |
| Compaction summary | Lossy summary that preserves decisions/artifacts. | Acceptance scenario compaction output; no private text. |

## RAG retrieval contract

A retrieval result should include:

```json
{
  "query": "path claim before edit",
  "hits": [
    {
      "id": "memory-001",
      "score": 0.91,
      "title": "Path claims",
      "excerpt": "Agents must claim paths before editing shared files.",
      "source": "memory/path-claims.md"
    }
  ]
}
```

Agents should cite memory hits by id/source instead of copying entire memory files into chat.

## CAG preload contract

CAG is for small, stable, high-signal context. It is not a dumping ground for logs or transcripts.

Rules:

- deterministic ordering;
- bounded size;
- no raw private transcripts;
- no tool-output spam;
- regenerated from operator-safe durable memory;
- versioned with a hash.

Example:

```text
# CAG-PRELOAD.example.md

## Coordination invariants
- Claim paths before editing.
- Every TASK requires a RESULT or explicit blocker.
- Sentinel release decisions are separate from owner upload approval.
```

## Compaction contract

Compaction should preserve:

- decisions;
- blockers;
- artifact paths;
- task/result ids;
- open questions;
- next actions.

Compaction should drop:

- repeated chat filler;
- raw tool output unless it is the artifact;
- private identifiers;
- stale self-observation;
- noisy logs.

## Promotion policy

Raw events become durable memory only if they pass at least one of:

- reusable procedure;
- important decision;
- repeated failure pattern;
- validated architecture fact;
- release/security constraint.

A promotion must include source id, timestamp, and confidence. If the source contains private data, promote only the operator-safe claim, not the raw source.

## Acceptance scenario mapping

The package includes `examples/memory-acceptance scenario/run-memory-acceptance scenario.js`, which acceptance scenarionstrates:

- synthetic durable memory corpus;
- minimal deterministic semantic scoring;
- CAG preload generation;
- compaction of a noisy task trace;
- promotion filter that accepts durable claims and rejects chat filler.

This is intentionally lightweight; production systems can replace the deterministic scorer with sqlite-vec, pgvector, local embeddings, or a managed vector database.
