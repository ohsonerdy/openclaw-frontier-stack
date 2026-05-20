# Runtime operations templates

OpenClaw Frontier Stack treats long-running agents, listeners, and control-plane adapters as supervised services. The package ships deployable templates with operator-supplied configuration: operators must replace placeholder paths, users, ports, and environment files before use.

## Principles

- Supervise every durable listener or daemon.
- Keep secrets outside the repository in an environment file or platform secret store.
- Prefer least-privilege service users.
- Write logs to operator-owned runtime directories, not into the package checkout.
- Emit health artifacts that can be attached to RESULT envelopes.
- Restart on crash with backoff; do not restart in tight failure loops.
- Keep process-manager state meaningful. If PM2 or another supervisor is used
  as the health source, run health checks through a persistent wrapper or use a
  native external scheduler. Do not model a healthy one-shot check as a
  permanently `stopped` service.
- Keep public release templates synthetic and placeholder-based.

## Included templates

| Template | Purpose |
| --- | --- |
| `templates/ops/pm2.ecosystem.config.example.js` | Cross-platform Node listener supervision example. |
| `templates/ops/launchd.agent.example.plist` | macOS user LaunchAgent example. |
| `templates/ops/systemd.service.example` | Linux systemd service example. |
| `templates/ops/health-snapshot.example.json` | Shape of a safe health artifact for release-gate evidence. |

## Health artifact contract

Health snapshots should be safe to publish after review:

```json
{
  "schema": "openclaw-frontier.health-snapshot.v1",
  "service": "signed-bus-listener",
  "status": "ok",
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "checks": [
    { "name": "process", "ok": true },
    { "name": "bus-connectivity", "ok": true }
  ]
}
```

Do not include real hostnames, private IPs, user home paths, environment dumps, raw logs, tokens, or session identifiers.

## One-shot Health Checks

Some diagnostics are naturally one-shot commands: they run, emit a report, and
exit with a status code. That is a good contract for CI and local verifiers, but
it is easy to misrepresent in a runtime process manager.

Use one of these patterns:

- Native scheduler: cron, launchd, systemd timer, Task Scheduler, or a managed
  job runner starts the one-shot command and stores the latest report.
- Persistent wrapper: a long-running supervisor process runs the one-shot
  command on an interval, writes the latest safe health artifact, and remains
  `online` while the cadence is healthy.

Avoid registering the one-shot command itself as a PM2 app when the dashboard is
treated as runtime truth. A successful one-shot exits by design, which leaves the
process manager showing `stopped` even when the last check passed.
