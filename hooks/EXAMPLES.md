# Event hook examples

This document collects illustrative event-hook implementations for the
Hermes-port lifecycle. Hooks are arbitrary executables that read a JSON
event from stdin and optionally write `{decision, reason}` or `{context}`
JSON to stdout. They are bound to events via `hooks/hooks.json` (the
`events` map) and gated by the consent allowlist at
`release-gate/hook-allowlist.json`.

These snippets are NOT shipped as real files — they are reference
implementations for operators who want to author their own hooks. To
install one, copy the snippet into your repo under `hooks/examples/`,
register it in `hooks.json`, then run:

```
openclaw hook allow <hook-id>
```

The `allow` step computes a SHA-256 over the executable bytes and writes
it to the allowlist. If the bytes change, the operator must re-run
`openclaw hook allow` for the dispatcher to spawn the new version.

## Event payload contract

Every hook is spawned with a single JSON object on stdin. The exact shape
depends on the event, but the canonical fields are:

| Event                     | Required fields                                   |
|---------------------------|---------------------------------------------------|
| `goal:start`              | `goalId`, `title`, `lanes` (count)                |
| `goal:end`                | `goalId`, `ok`, `status`, `ms`                    |
| `lane:dispatch`           | `goalId`, `laneId`, `role`, `subject`             |
| `lane:result`             | `goalId`, `laneId`, `role`, `status`, `ms`        |
| `release-gate:propose`    | `gateId`, `proposedBy`, `summary`                 |
| `release-gate:approve`    | `gateId`, `approvedBy`                            |
| `release-gate:reject`     | `gateId`, `rejectedBy`, `reason`                  |

Hooks should treat unknown fields as forward-compatible — never fail on
extra keys.

## Example 1 — `goal:start` logger

file://hooks/examples/log-goal-starts.sh

```sh
#!/usr/bin/env bash
# log-goal-starts.sh — append every goal:start event to a local log file.
# Returns { decision: "continue" } so dispatch never blocks on logging.

set -euo pipefail

INPUT="$(cat)"
LOG="${OPENCLAW_GOAL_LOG:-./.openclaw/goal-starts.log}"
mkdir -p "$(dirname "$LOG")"

# Append a one-line JSON record. We do NOT print the payload to stdout
# because that would confuse the dispatcher; stdout is reserved for the
# hook decision.
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$INPUT" >> "$LOG"

printf '{"decision":"continue"}'
```

Register it in `hooks/hooks.json`:

```json
{
  "events": {
    "goal:start": [
      { "id": "log-goal-starts", "executable": "hooks/examples/log-goal-starts.sh", "timeoutMs": 2000 }
    ]
  }
}
```

Allow it:

```
openclaw hook allow log-goal-starts
```

## Example 2 — `lane:dispatch` cost estimator (context hook)

file://hooks/examples/estimate-cost.js

```js
#!/usr/bin/env node
'use strict';
// estimate-cost.js — read a lane:dispatch event and return a coarse cost
// hint as context. The dispatcher accumulates context entries from every
// allowed hook and surfaces them on the dispatch result, where the
// orchestrator can fold them into the goal state.

const COST_PER_ROLE = {
  builder: 0.15,
  reviewer: 0.04,
  sentinel: 0.02,
  architect: 0.08,
};

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(stdin || '{}'); }
  catch (_) { event = {}; }
  const role = event.role || 'builder';
  const hint = COST_PER_ROLE[role] != null ? COST_PER_ROLE[role] : 0.10;
  const context = {
    schema: 'openclaw-frontier.hook-context.cost-hint.v1',
    laneId: event.laneId || null,
    role,
    estimatedUsd: hint,
  };
  process.stdout.write(JSON.stringify({ context }));
});
```

Register it:

```json
{
  "events": {
    "lane:dispatch": [
      { "id": "estimate-cost", "executable": "hooks/examples/estimate-cost.js", "timeoutMs": 1500 }
    ]
  }
}
```

Allow it:

```
openclaw hook allow estimate-cost
```

## Example 3 — `release-gate:propose` policy gate (blocker)

file://hooks/examples/require-sentinel-receipt.js

```js
#!/usr/bin/env node
'use strict';
// require-sentinel-receipt.js — a release-gate:propose hook that blocks
// the gate unless the proposal references a sentinel receipt.

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(stdin || '{}'); } catch (_) { /* fall through */ }
  const refs = Array.isArray(event.references) ? event.references : [];
  const hasSentinel = refs.some((r) => typeof r === 'string' && r.includes('sentinel-decision'));
  if (!hasSentinel) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: 'release-gate:propose requires a sentinel-decision receipt in references',
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ decision: 'continue' }));
});
```

Register it under the prefix-glob `release-gate:*` to apply to every
release-gate event:

```json
{
  "events": {
    "release-gate:*": [
      { "id": "require-sentinel-receipt", "executable": "hooks/examples/require-sentinel-receipt.js", "timeoutMs": 2000 }
    ]
  }
}
```

Allow it:

```
openclaw hook allow require-sentinel-receipt
```

## Decision protocol

Hooks may emit any of these JSON shapes on stdout:

- `{ "decision": "continue" }` — the hook ran, no opinion, no context.
- `{ "decision": "block", "reason": "<why>" }` — the hook objects. The
  dispatcher short-circuits the rest of the chain and returns
  `decision: 'block'` with this reason.
- `{ "context": <any-json> }` — the hook contributes a context payload.
  These accumulate across all hooks bound to the event and surface on
  `dispatch().context`.
- `{ "decision": "continue", "context": <any-json> }` — combined.

Empty stdout (no bytes printed) is treated as `continue` with no context
— useful for hooks that only have side effects (e.g. write to a log
file).

Malformed stdout, non-zero exit codes, timeouts, and hooks not in the
allowlist are all silently skipped. The dispatcher records each skip on
its observability channel (`onWarn`) but never propagates the failure to
the orchestrator. This keeps third-party hooks from breaking the goal
loop.

## Safety properties

1. Every hook executable must appear in `release-gate/hook-allowlist.json`
   with a SHA-256 over its exact bytes.
2. Replacing the executable on disk invalidates the allowlist entry — the
   operator must re-run `openclaw hook allow <hook-id>` to consent to the
   new bytes.
3. The allowlist lives in-repo (NOT under `$HOME`) so code review and CI
   can audit consent changes.
4. The dispatcher never auto-adds entries. The only way to allow a hook is
   the explicit `openclaw hook allow` command.
