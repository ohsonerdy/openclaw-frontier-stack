# openclaw-cron — scheduler daemon

`openclaw-cron` is a small file-locked daemon that turns a JSON list of
cron-scheduled jobs into `task-claim` records on the blackboard ledger.
It does no model dispatch of its own — downstream `openclaw-agent`
daemons pick the claims up and carry them through their role contracts.

This page is the operator guide. The CLI's `--help` covers flags;
this page covers the data model, the operational surface, and the
failure modes you need to know about before pointing the daemon at a
live blackboard.

## Overview

- One daemon per blackboard. The daemon ticks on a fixed interval
  (60 seconds by default) and inspects `cron/jobs.json`. Every job
  whose schedule has fired since its last recorded run gets a single
  `task-claim` record on the blackboard, routed to the job's role.
- File-locked. Every tick acquires a `mkdir`-style lock at
  `release-gate/cron-tick.lock`. A second tick that races the first
  aborts cleanly and waits for the next interval. A lock older than
  five minutes is treated as abandoned and reclaimed.
- Stateless ish. The only piece of state the daemon owns is the
  per-job `lastRun` timestamp map, stored alongside `jobs.json` at
  `.last-run.json`. Deleting that file resets the daemon — the next
  tick treats every job as having last run one minute ago.

## jobs.json schema

Either an array of job objects or `{ "schema": "...", "jobs": [...] }`
is accepted. The shipped template uses the wrapped form so the file
can carry the schema id for downstream tooling.

```json
{
  "schema": "openclaw-frontier.cron-jobs.v1",
  "jobs": [
    {
      "id": "daily-recap",
      "schedule": "0 9 * * *",
      "role": "executive-summary",
      "subject": "scheduled:daily-recap",
      "body": {
        "goalsDir": "release-gate/goals",
        "windowHours": 24,
        "format": "ledger-summary"
      }
    }
  ]
}
```

Required fields:

| Field      | Type   | Constraint                                              |
| ---------- | ------ | ------------------------------------------------------- |
| `id`       | string | `[A-Za-z0-9][A-Za-z0-9._:-]*`, unique within the file   |
| `schedule` | string | Standard 5-field cron expression (see below)            |
| `role`     | string | `[A-Za-z][A-Za-z0-9_-]*` — the agent role to dispatch to |
| `subject`  | string | Non-empty human-readable subject for the task           |

Optional:

| Field  | Type   | Notes                                                   |
| ------ | ------ | ------------------------------------------------------- |
| `body` | object | Operator-supplied payload appended as a `fact` record   |

The `body` payload is written to the ledger as a separate `fact`
record on the same tick, keyed by `subject: "cron-job:<id>"`. The
`task-claim` summary stays compact so it fits inside the ledger's
500-character summary cap; the downstream agent reads the matching
`fact` record to recover the full body.

## Schedule syntax

Standard 5-field POSIX cron:

```
minute  hour  day-of-month  month  day-of-week
0-59    0-23  1-31          1-12   0-6 (0=Sun)
```

Supported per-field syntax:

| Token   | Meaning                                                  |
| ------- | -------------------------------------------------------- |
| `*`     | every value in range                                     |
| `N`     | a single integer                                         |
| `N,M`   | comma-separated list of values                           |
| `N-M`   | inclusive range                                          |
| `N-M/S` | range with step S                                        |
| `*/S`   | every Sth value across the full range                    |

Day-of-month and day-of-week are OR-coupled per POSIX cron: a day
matches if either field hits, unless one of them is `*` (in which
case the other field is the sole constraint).

Worked examples:

| Expression       | Fires                                             |
| ---------------- | ------------------------------------------------- |
| `0 9 * * *`      | daily at 09:00 UTC                                |
| `0 * * * *`      | hourly on the 0th minute                          |
| `*/15 * * * *`   | every 15 minutes                                  |
| `0 0 1 * *`      | midnight on the 1st of each month                 |
| `0 0 5 * 1`      | midnight on the 5th OR any Monday                 |
| `30 14 1-5 * *`  | 14:30 on days 1 through 5 of every month          |

All times are interpreted in UTC. Operators that care about a local
timezone should encode the offset into the schedule directly (e.g.
`0 13 * * *` for 09:00 US-Eastern during standard time).

## Records written to the blackboard

For each due job per tick, the daemon writes:

1. A `task-claim` record:
   - `agent: "cron"` (the daemon is the author)
   - `forRole: <job.role>` (routes the claim to the right agent)
   - `taskId: "cron:<job.id>:<dueAt-ms>"`
   - `summary: "[cron <id> @ <iso>] <subject>"`
2. A `fact` record:
   - `agent: "cron"`
   - `subject: "cron-job:<id>"`
   - `value: { schema, jobId, schedule, role, subject, body, taskId, dueAt }`

The downstream agent daemon's existing `findPendingClaims` logic picks
the claim up via the `forRole` field and runs it through the role
contract just like any other dispatched task.

## Deployment

The daemon is intended to run under a supervisor. Two examples follow.

### systemd (Linux operator)

```ini
# /etc/systemd/system/openclaw-cron.service
[Unit]
Description=openclaw-cron scheduler daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/openclaw-frontier-stack
ExecStart=/usr/bin/env node bin/openclaw-cron \
  --jobs cron/jobs.json \
  --blackboard blackboard.jsonl \
  --lock release-gate/cron-tick.lock
Restart=on-failure
RestartSec=10s
User=openclaw

[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now openclaw-cron.service` after
checking in your operator-edited `cron/jobs.json`.

### launchd (macOS operator)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.cron</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>bin/openclaw-cron</string>
    <string>--jobs</string><string>cron/jobs.json</string>
    <string>--blackboard</string><string>blackboard.jsonl</string>
    <string>--lock</string><string>release-gate/cron-tick.lock</string>
  </array>
  <key>WorkingDirectory</key><string>/srv/openclaw-frontier-stack</string>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/openclaw-cron.out</string>
  <key>StandardErrorPath</key><string>/var/log/openclaw-cron.err</string>
</dict>
</plist>
```

Drop the plist at `/Library/LaunchDaemons/com.openclaw.cron.plist`
and load with `launchctl bootstrap system <path>`.

### Manual / supervisor (pm2, foreman, …)

`node bin/openclaw-cron --jobs cron/jobs.json` runs in the foreground
indefinitely. Any process supervisor that restarts on exit is fine.
Use `--once` to single-step a tick from inside another scheduler
(e.g. a host-level cron entry calling the daemon every minute).

## Troubleshooting

| Symptom                                        | Likely cause                                                                                                   | Fix                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `another tick is already running, skipping`    | Two ticks raced; the second aborted as designed.                                                                | Inspect the lock at `release-gate/cron-tick.lock`. Older than five minutes means abandoned — safe to delete. |
| `jobs file is not valid JSON`                  | A trailing comma or unbalanced brace.                                                                          | Run `node -e "JSON.parse(require('fs').readFileSync('cron/jobs.json','utf8'))"` to find the parse line. |
| `cron expression must have 5 fields`           | A `@hourly`-style alias was used; only literal 5-field expressions are supported.                              | Expand the alias to its 5-field form.                                                                |
| `duplicate job id`                             | Two entries share the same `id`.                                                                                | Rename or remove the collision; job ids must be unique within `jobs.json`.                           |
| No claims appearing on the blackboard          | The cron tick fired but no jobs were due yet (e.g. fresh install with all-future schedules).                   | Run `node bin/openclaw-cron --once --quiet` and inspect the stderr — the daemon logs every dispatch. |
| Old job ids keep firing after a rename         | The `.last-run.json` state file still references the old ids.                                                  | Delete the state file (default: `cron/.last-run.json`); the daemon will re-seed on the next tick.    |

## See also

- `bin/openclaw-agent` (the live role-runner that picks up claims this
  daemon writes — see `docs/agent-daemon.md`).
- `src/blackboard/lib/ledger.js` (the JSONL ledger this daemon writes
  records to — see `docs/bus-and-blackboard-protocol.md`).
