# openclaw doctor

`openclaw doctor` is a runtime health check. It probes the live environment —
blackboard reachability, signed-bus identity-key presence, role contracts on
disk, model backend connectivity, prior verifier status — and emits a JSON
report plus a human-readable summary.

This is distinct from `npm run verify`, which is a build-time
package-correctness gate. `doctor` is for the operator who just cloned the
repo, just changed env vars, or just hit a runtime problem and wants a
one-shot triage.

## When to run

- After a fresh clone, to confirm the workspace can actually run the harness.
- After changing env vars (auth tokens, identity key paths).
- Before opening a goal that needs live agents.
- As a quickstart probe when you suspect the environment regressed.
- Inside CI as a smoke check ahead of the heavier verifier suite.

## Usage

```
openclaw doctor [--json] [--no-network] [--blackboard <path>]
```

Flags:

- `--json` emits the raw doctor report as JSON. Default output is a small
  human-readable table.
- `--no-network` skips the `modelBackendReachable` HTTP probe. Use this in
  offline environments and on CI runners that block egress.
- `--blackboard <path>` overrides the path used by `blackboardReachable`.
  Defaults to `release-gate/blackboard.jsonl` under the current working
  directory.

Exit codes:

- `0` — the doctor report is `ok: true` (no error-severity failures).
- `1` — at least one error-severity check failed.
- `2` — bad CLI arguments.

## Output schema

```json
{
  "schema": "openclaw-frontier.doctor-report.v1",
  "ok": true,
  "generatedAt": "2026-05-19T12:34:56.000Z",
  "options": {
    "repoRoot": "...",
    "blackboard": "...",
    "noNetwork": false,
    "endpoint": null
  },
  "checks": [
    {
      "name": "nodeVersionOk",
      "ok": true,
      "severity": "info",
      "detail": { "node": "20.10.0", "major": 20, "required": 20 }
    }
  ],
  "summary": {
    "total": 8,
    "passed": 8,
    "failed": 0,
    "bySeverity": { "error": 0, "warn": 0, "info": 8 }
  }
}
```

Aggregation rule: `ok` is `true` only when no check has both
`ok: false` and `severity: 'error'`. Checks with severity `warn` and `info`
never block the verdict — they're advisory.

## Checks

### `nodeVersionOk`

Severity: `error`. Confirms the Node.js runtime is `>=20`. The Frontier Stack
will not run correctly on Node 18 or older.

Troubleshooting: install Node 20 via your package manager or nvm
(`nvm install 20 && nvm use 20`).

### `roleContractsPresent`

Severity: `error`. Walks every subdirectory under `agents/` and confirms each
has a `CONTRACT.md`. Roles in coordination patterns are arbitrary strings
supplied by callers, so this check validates the on-disk roster rather than
any specific list.

Troubleshooting: if an agent directory is missing its contract, restore it
from the canonical roster or remove the orphan directory. See
`docs/agent-system.md` for the contract template.

### `blackboardReachable`

Severity: `error`. Appends a one-line probe record to the configured
blackboard path and then removes the probe so no residue remains. Verifies
both that the directory exists (or can be created) and that the file is
writable.

Troubleshooting: if this fails, check the parent directory permissions and
disk space. The default path is `release-gate/blackboard.jsonl` under the
current working directory; pass `--blackboard <path>` to probe a different
location.

### `signedBusKeysPresent`

Severity: `error` when configured but invalid, `info` when unconfigured. If
`OPENCLAW_IDENTITY_KEY` is set (or `--identity-key` is passed to the agent
daemon), this check resolves the path and verifies it parses as an Ed25519
private key in either PEM or OpenSSH format.

The check never logs the key bytes. Only `{ configured, exists, format,
asymmetricKeyType }` appears in the report.

Troubleshooting: regenerate the key with `ssh-keygen -t ed25519 -f id_ed25519
-N ""` or `openssl genpkey -algorithm ed25519 -out identity.pem`.

### `modelBackendConfigured`

Severity: `warn` when missing. Reports which auth env var is present without
leaking the value. Resolution order:

1. `ANTHROPIC_OAUTH_TOKEN` (provider: `anthropic`, authMethod: `oauth`)
2. `ANTHROPIC_API_KEY` (provider: `anthropic`, authMethod: `api-key`)
3. `OPENCLAW_EVAL_API_KEY` (provider: `openai-compatible`, authMethod: `api-key`)
4. `OPENAI_API_KEY` (provider: `openai`, authMethod: `api-key`)

The actual token value is never read into the report. Only the env-var name
and resolved provider/auth-method shape are surfaced.

Troubleshooting: export one of the four env vars above. For OAuth tokens, see
`docs/agent-daemon.md`.

### `modelBackendReachable`

Severity: `warn` when unreachable. Issues a HEAD request to the resolved
backend URL with a 3-second timeout. Any HTTP response — including 4xx — is
treated as reachable, because the relevant signal is "is the host alive". A
network error or timeout produces a WARN-severity failure.

Skipped under `--no-network`. Skipped automatically when no backend is
configured.

Troubleshooting: confirm DNS and outbound HTTPS work from the host. On
restricted networks, pass `--no-network` to skip this check.

### `verifierLatest`

Severity: `info` when absent or passing, `warn` when the latest verifier run
failed. Reads `release-gate/reports/latest-verification.json` and surfaces
`generatedAt`, `verifierOk`, and `checkCount`. The check itself never runs
the verifier — it just reads the prior run's report.

Troubleshooting: run `npm run verify`. The verifier writes a fresh report at
the well-known path.

### `ticketStoreOk`

Severity: `warn` when unreadable. Opens the ticket store at
`release-gate/tickets.jsonl` (or the path passed via `--tickets-path` to the
ticket CLI) and counts tickets by state. Always passes for a fresh project
with no tickets.

Troubleshooting: if the store is unreadable, the JSONL file may be corrupted.
Inspect with `node -e "console.log(require('./src/tickets/lib/ticket-store.js').parseJsonl(require('fs').readFileSync('release-gate/tickets.jsonl','utf8')))"`.

## Programmatic API

```js
const { runDoctor, formatHumanReadable } = require('@openclaw/frontier-stack/lib/doctor');

const report = await runDoctor({
  repoRoot: process.cwd(),
  blackboard: 'release-gate/blackboard.jsonl',
  noNetwork: true,
});

if (!report.ok) {
  process.stderr.write(formatHumanReadable(report) + '\n');
  process.exit(1);
}
```

Options:

- `repoRoot` — defaults to `process.cwd()`.
- `blackboard` — defaults to `<repoRoot>/release-gate/blackboard.jsonl`.
- `identityKey` — overrides `OPENCLAW_IDENTITY_KEY` for `signedBusKeysPresent`.
- `noNetwork` — boolean; skips `modelBackendReachable`.
- `endpoint` — overrides the resolved backend URL.
- `timeoutMs` — HEAD-probe timeout for the network check (default 3000ms).
- `ticketsPath` — overrides the ticket store path.
- `agentsDir` — overrides the roles directory.
- `verifierReportPath` — overrides the prior-run report path.
- `env` — alternate env object for testing.
