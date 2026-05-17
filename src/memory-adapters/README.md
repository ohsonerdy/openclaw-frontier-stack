# Memory adapters

Production-safe reference adapters for the OpenClaw Frontier memory layer.

The implementation is dependency-free and local-only. It is intentionally simple so engineers can replace it with sqlite-vec, pgvector, hosted embeddings, or another production index while keeping the same package boundaries. See [`docs/memory-rag-cag-compaction.md`](../../docs/memory-rag-cag-compaction.md) for the layered architecture this package targets.

## Capability surface

The module (`lib/memory-adapters.js`) exports:

| Export | Layer | Capability |
| --- | --- | --- |
| `LexicalVectorIndex` | RAG / vector index | In-memory cosine-similarity retrieval over a term-frequency vector with English stopword filtering. `addDocument({ id, text, metadata })` and `search(query, { limit, minScore })`. |
| `CagPreloadCache` | CAG preload | Keyed payload cache with deterministic SHA-256 integrity stamping over `{ payload, sourceIds }`. `put({ key, payload, sourceIds })` and `get(key)`. |
| `compactTranscript` | Compaction | Bounded-length summary over a message array, with SHA-256 of the original join for traceability. |
| `promotionFilter` | Durable-memory promotion | Tag-driven accept/reject (`decision`, `architecture`, `release-gate` accepted; `secret`/`token`/`password`/`oauth`/`private key`/`raw log`/`session dump` rejected). |
| `tokenize` | Helper | Public tokenizer used by the lexical index; lowercase, alphanumeric, stopword-filtered. |
| `MemoryAdapterError` | Validation | Thrown on any validation or production-safety failure; carries `code = 'MEMORY_ADAPTER_VALIDATION'` and a `details` object. |
| `SCHEMA` | Identity | `openclaw-frontier.memory-adapters.v1`; stamped on every produced record. |

All adapters are stateless across processes and hold state only in memory for the lifetime of the instance.

## Privacy guardrails

Every adapter that accepts user-supplied content runs `assertPublicSafe` on the produced record before returning. The scanner rejects any input whose JSON form matches:

- POSIX or Windows home paths (`/Users/<name>`, `C:\Users\<name>`).
- PEM private-key headers.
- Common API-token shapes (`sk-`, `ghp_`, `github_pat_`, `xox[abpors]-`).
- Telegram bot-token shape (`<digits>:<token>`).
- IPv4 literals.

In addition, `promotionFilter` performs a content-shape veto on any candidate text mentioning `secret`, `token`, `password`, `oauth`, `private key`, `raw log`, or `session dump`, regardless of tag set.

Inputs are also length-bounded (`text` ≤ 4000 chars, `payload` ≤ 8000 chars, individual `message` ≤ 2000 chars, `tag` ≤ 64 chars) and ids must match `^[A-Za-z0-9][A-Za-z0-9._:-]*$`.

## Run test

```bash
node src/memory-adapters/test/memory-adapters-local.test.js
```

The test exercises retrieval ranking, CAG hash stability, compaction byte budget, the three promotion-filter paths (accept / not-durable / sensitive-shape), and the production-safety scanner (the home-path rejection case is asserted).

## Replacing the reference implementation

Production swarms should keep this package boundary and swap the internals:

- `LexicalVectorIndex` → sqlite-vec, pgvector, or a hosted embedding index. Preserve `addDocument`/`search` signatures and continue to call `assertPublicSafe` on stored documents.
- `CagPreloadCache` → on-disk or KV-backed cache. Continue to stamp `sha256` over `{ payload, sourceIds }` so preloads are versioned.
- `compactTranscript` → an LLM- or rule-based summarizer. Continue to emit a `sha256` over the original join so the compaction can be audited against the source.
- `promotionFilter` → richer policy (confidence, source provenance, reviewer signal). Keep the sensitive-content veto.
