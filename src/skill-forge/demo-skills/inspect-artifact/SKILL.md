---
name: inspect-artifact
description: Inspect a local synthetic artifact and report size, SHA-256, and a bounded safe preview. Use for demo artifacts only; no secrets, private paths, or live runtime files.
---

# Inspect Artifact

Use this skill to inspect a local demo artifact and return evidence for a RESULT contract.

Rules:

- Read-only.
- Local files only.
- Synthetic demo artifacts only.
- Do not inspect credentials, private paths, logs, session DBs, memory dumps, or live runtime files.
- Use `scripts/inspect-artifact.js <path>` for deterministic output.

Expected output:

```json
{
  "ok": true,
  "path": "examples/demo-swarm/out/demo-health-endpoint.patch",
  "bytes": 123,
  "sha256": "...",
  "preview": "bounded text preview"
}
```
