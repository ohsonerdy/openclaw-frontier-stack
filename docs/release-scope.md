# Release scope

## SHIP as core framework

- Role taxonomy: Orchestrator, Architect, Sentinel, Scout, Builder, Reviewer.
- Signed envelope protocol: TASK, RESULT, FACT, DECISION, ALERT, HEARTBEAT.
- Blackboard semantics: task claims, path claims, ownership, conflict avoidance, verification.
- Memory architecture docs: RAG/vector retrieval, promotion policy, CAG preload, compaction boundaries.
- Task orchestration patterns: durable tasks, waits/resumes, result contracts, reviewer gates.
- Eval/observability patterns: trace a request from ingress to result artifact.
- Release gate tooling: allowlist export, scanner integration, 4/4 review records.

## SANITIZE before shipping

- Mission Control UI: ship shell + synthetic board/acceptance scenario data + dry-run writeback only.
- Skill Forge/tool backends: ship pluggable interface and safe acceptance scenario tools; no private model assets or personal prompts.
- Runtime durability examples: generic PM2/LaunchAgent/system-service patterns, no workstation-specific paths.
- MCP/integration examples: mock endpoints and fake credentials only.

## EXCLUDE

- Any live private runtime state.
- Any credentials, token caches, OAuth state, SSH private keys, vault material.
- Personal memories, Telegram IDs, private chats, transcripts, raw logs, session DBs, embeddings over private content.
- Client/private business context.
- Personal-domain content that weakens engineering framing.
- Real hostnames, IPs, machine names, absolute private paths, backups, or personal cron jobs.

## Public framing

Use: "OpenClaw Frontier Stack: coding swarms with shared state, memory, task ownership, and verifiable release gates."

Avoid: "the operator's personal runtime dump" or anything that implies a private-life runtime export.
