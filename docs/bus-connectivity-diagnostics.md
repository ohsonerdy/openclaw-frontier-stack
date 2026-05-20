# Bus connectivity diagnostics

Status: SHIP as production-safe diagnostic runbook.

This runbook helps distinguish three different failure classes in a signed bus fleet: publisher offline, transport unreachable, and signature verification failure. It uses synthetic names and placeholder endpoints only.

## Failure classes

| Symptom | Likely class | First check |
| --- | --- | --- |
| No events from an agent appear in subscriber/audit logs | Publisher offline or wrong bus URL | Check publisher process, `SQUAD_BUS_URL`, and local connect errors. |
| Connect attempts fail before publish | Transport unreachable | Check local DNS/routing/firewall for the configured bus endpoint. |
| Events arrive but are rejected as unknown key or bad signature | Verification failure | Check `SQUAD_BUS_AGENT_ID`, public-key filename, and signing keypair match. |
| Events verify but task results are ignored | Contract mismatch | Check result type, recipient, lineage, and required output fields. |

## Minimal safe evidence packet

Ask the remote agent or host operator for this bounded evidence, with secrets redacted:

```json
{
  "agent_id": "agent-id",
  "bus_url_host_label": "placeholder-bus-host",
  "publisher_process_running": true,
  "last_connect_ok": true,
  "last_connect_error_class": null,
  "public_key_fingerprint": "SHA256:placeholder",
  "signing_identity": "agent-id@example-host",
  "dry_run_envelope_path": "status/agent/bus-dry-run-envelope.json",
  "last_publish_attempt_at": "YYYY-MM-DDTHH:MM:SSZ"
}
```

Do not request or transmit private keys, tokens, OAuth files, raw logs, private hostnames/IPs, personal filesystem paths, chat IDs, memories/transcripts, vector stores, backups, or client context.

## Diagnostic order

1. Confirm the publisher process is running on the agent host.
2. Confirm the publisher uses the intended `SQUAD_BUS_AGENT_ID`.
3. Confirm the publisher points at the intended bus endpoint label, not a stale local default.
4. Confirm the publisher can open a transport connection.
5. Publish a dry-run/synthetic envelope locally and record its public-key fingerprint.
6. If subscribers see no event, treat it as publisher/transport.
7. If subscribers see verification drops, compare public-key filename, agent id, and fingerprint.
8. If subscribers verify the event but ignore it, inspect the task/result contract.

## Boundary

This runbook is diagnostic only. It does not authorize remote login, key installation, service restarts, network exposure changes, publication, or external announcements.
