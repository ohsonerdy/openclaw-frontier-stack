# Agent ticketing — operator guide

This guide documents the ticket FSM that sits on top of the OpenClaw Frontier
Stack's existing blackboard ledger and taskflow runtime. Where the blackboard
tracks per-project operational state and taskflow tracks in-flight goal
execution, tickets are the **repo-wide, persistent record of work that
exists** — from open queue through closure and archive.

If a goal is "the swarm has been given a thing to do right now", a ticket is
"this is a thing that should be done, by someone, eventually, and we're
tracking the state of that thing across sessions". One goal can spawn N
tickets. One ticket survives across many goals.

## State machine

```
                       ┌──────────────────────────────────────────────────┐
                       │                                                  │
                       │                  ┌──── requestChanges ────┐      │
                       ▼                  │                        │      │
        ┌───────┐  claim   ┌─────────────┐   requestReview  ┌──────────┐  │
   ────▶│ open  │─────────▶│ in-progress │─────────────────▶│  review  │  │
        └───┬───┘          └──────┬──────┘                  └────┬─────┘  │
            │                     │                              │        │
            │                     │  close (cancel)              │ approveReview
            │                     │                              ▼
            │                     │                          ┌──────┐
            │                     │                          │ done │
            │                     │                          └───┬──┘
            │                     │                              │
            │                     │     close                    │
            │                     ▼                              │
            │              ┌──────────┐ ◀────────────────────────┘
            └─────────────▶│ archived │
                           └──────────┘
                                ▲
                                │ reopen (back to in-progress)
                                ▼
                          [in-progress]
```

The `blocked` state shown by `list` and `show` is **derived**: a ticket whose
`dependsOn` list contains at least one ticket that is not yet `done` or
`archived` is reported as blocked. It is not a separate FSM state. This
mirrors how the taskflow runtime surfaces `queued` versus `claimed` without
needing an explicit blocked terminal — the state stays whatever it is, and
the blocked flag is a query-time annotation.

### Transition reference

| from        | event              | to            |
|-------------|--------------------|---------------|
| open        | claim              | in-progress   |
| open        | close (cancel)     | archived      |
| in-progress | requestReview      | review        |
| in-progress | close (cancel)     | archived      |
| review      | requestChanges     | in-progress   |
| review      | approveReview      | done          |
| done        | close              | archived      |
| done        | reopen             | in-progress   |
| archived    | reopen             | in-progress   |

Invalid transitions throw `TicketStateError`. Missing required fields throw
`TicketValidationError`. Both subclass `Error` so callers can `catch` either.

### Author identity

Every transition is recorded with a `by` field (a simple agent id matching
`/^[A-Za-z][A-Za-z0-9_-]*$/`). This is **mandatory** — there is no way to
mutate a ticket without naming the actor responsible. Operator-initiated
work uses `--by operator`; automated work uses the role id of the agent.

## Storage

Tickets live at `release-gate/tickets.jsonl` by default. Each line is a
self-describing event under schema `openclaw-frontier.ticket-store.v1`.

Override the path:

```
# Per-invocation:
openclaw ticket open "..." --tickets-path /some/where/else.jsonl

# Per-process:
OPENCLAW_TICKETS_PATH=/some/where/else.jsonl openclaw ticket list
```

The store is event-sourced; the current state of every ticket is computed by
replaying the log via `snapshot()`. This means:

- The file is append-only. A backup is just `cp tickets.jsonl tickets.bak`.
- A corrupted line will throw a `TicketValidationError` at next read — fix
  the line and retry.
- Migrating to a new schema = write a transformer that consumes the old log
  and emits a new one. The shape of records on disk is open data.

The same single-writer lock pattern used by the blackboard ledger guards the
file (`mkdir` lockdir with stale-lock recovery). Concurrent CLI invocations
will queue on the lock rather than corrupt the log.

## CLI cookbook

### Create a ticket

```
openclaw ticket open "Add SLO dashboard for tickets" \
  --by operator \
  --priority p1 \
  --sla-hours 72 \
  --assigned-to builder \
  --body "Operator wants a single panel that shows ticket counts by state."
```

The ticket id is auto-generated (`ticket-<uuid>`) and printed. Pass `--id`
or use the programmatic API if you need a deterministic id.

### List + filter

```
openclaw ticket list                          # everything
openclaw ticket list --status open            # only open
openclaw ticket list --status in-progress     # only in-progress
openclaw ticket list --priority p0            # only p0
openclaw ticket list --assigned-to builder    # by assignee
openclaw ticket list --blocked                # blocked by a dependency
openclaw ticket list --since 2026-05-01T00:00:00Z  # updated since ISO ts
```

JSON output (composable with `jq`):

```
openclaw ticket list --status review --json | jq '.tickets[].id'
```

### Show one

```
openclaw ticket show <id>
```

Renders the full state with history (every transition with timestamp + author).

### Walk the happy path

```
openclaw ticket claim   <id> --by builder
openclaw ticket review  <id> --by builder --reviewer reviewer
openclaw ticket approve <id> --by reviewer
openclaw ticket close   <id> --by orchestrator --resolution "shipped clean"
```

### Reject + iterate

```
openclaw ticket request-changes <id> --by reviewer --comment "needs tests"
# … builder iterates …
openclaw ticket review  <id> --by builder --reviewer reviewer
openclaw ticket approve <id> --by reviewer
```

### Cancel an open ticket

```
openclaw ticket close <id> --by operator --resolution "wont-fix: superseded by tk-other"
```

A `close` from `open` or `in-progress` is the cancel path. The ticket lands in
`archived` with whatever `resolution` string the operator supplied. Downstream
tickets that depended on this one will become unblocked, because closure (of
any kind, including cancel) satisfies the dependency.

### Reassign

```
openclaw ticket assign <id> --to other-agent --by operator
```

`assign` records a new assignee but does not change FSM state. A ticket in
`open` stays `open` after assignment; an `in-progress` ticket stays
in-progress with a new assignee.

### Manage dependencies

```
openclaw ticket add-dep    <id> --depends-on <other-id> --by operator
openclaw ticket remove-dep <id> --depends-on <other-id> --by operator
```

The store rejects:
- self-dependencies (a ticket cannot depend on itself)
- cycles (B depends on A; trying to add A depends on B fails)
- dependencies on non-existent tickets

### Reopen

```
openclaw ticket reopen <id> --by operator --reason "regression discovered in prod"
```

Only `done` or `archived` tickets can be reopened. The reopen lands them back
in `in-progress` — they do not return to `open`, because the work has already
been picked up at least once. A `lastReopenReason` field is recorded for
audit.

### SLA breaches

```
openclaw ticket sla-breaches            # human-readable
openclaw ticket sla-breaches --json     # machine-readable
```

A ticket is "in breach" when:
- it has a positive `slaHours` value, AND
- its FSM state is not `archived`, AND
- hours elapsed since `createdAt` exceed `slaHours`.

SLA is measured in **hours** against the original `createdAt` timestamp.
Reopening does not reset the SLA clock — the clock is the original create
time. This is deliberate: the operator-facing question is "how long has this
issue been open?", not "how long has the most recent attempt been pending?".

The job at `.github/workflows/ticket-sla-escalation.yml` runs hourly and
opens a GitHub issue labeled `ticket-sla-breach` for every breach. Same
dedup pattern as the eval-drift loop: one open issue per ticket id; each
re-run comments with the latest elapsed time on the existing issue.

### Recap

```
openclaw ticket recap                  # default 7 days
openclaw ticket recap --days 30        # last 30 days
openclaw ticket recap --json           # for piping into dashboards
```

The recap is what `executive-summary` reads when it produces its daily and
weekly rollups. It surfaces:

- counts by state (`open`, `in-progress`, `review`, `done`, `archived`)
- the list of breached tickets
- the most recently updated tickets (top 20)

## Integration with goals

A goal is short-lived and tied to one orchestrator session: "do this thing
now". A ticket is long-lived: "track this thing across sessions until it's
archived". The two layers are **independent**: nothing in the existing
taskflow runtime or blackboard ledger touches `tickets.jsonl`.

The expected workflow is:

1. Operator (or executive-summary) decides a piece of work should exist:
   `openclaw ticket open "..." --by operator`.
2. When the swarm has capacity, orchestrator claims the ticket:
   `openclaw ticket claim <id> --by orchestrator`.
3. Orchestrator decomposes the ticket into a goal and dispatches lanes
   normally — those lanes run through the **taskflow** runtime, not the
   ticket store.
4. When all lanes return GREEN, orchestrator requests review:
   `openclaw ticket review <id> --by orchestrator --reviewer reviewer`.
5. Reviewer either approves or requests changes; on approval, ticket lands
   in `done`. Operator archives with a resolution string.

One goal can correspond to one ticket, or one ticket can spawn multiple
goals over time. The ticket id is the long-term handle; goal ids come and
go.

## Integration with the executive-summary rollup

The executive-summary role reads the ticket store on every cadence cycle
(daily / weekly). Its rollup `fact` record now includes ticket counts
alongside blackboard counts and taskflow counts. See
`agents/executive-summary/CONTRACT.md` for the formal inputs list.

## SLA-escalation autonomous loop

The workflow `.github/workflows/ticket-sla-escalation.yml` runs hourly:

1. Reads `release-gate/tickets.jsonl` (skips if absent).
2. Runs `openclaw ticket sla-breaches --json` to compute the breach list.
3. For each breached ticket: looks up an existing open issue with label
   `ticket-sla-breach` and the ticket id in the body. If none, opens a new
   issue. If one exists, comments with the current elapsed time.
4. Always uploads the breaches JSON as a workflow artifact for audit.

This loop is **read-only on the ticket store**. The ledger remains the
source of truth; GitHub issues are the escalation surface.

To resolve an escalation: walk the ticket to `archived` via the normal
lifecycle. The next hourly run will stop finding the ticket in breaches and
the operator can close the GitHub issue (the workflow does not auto-close).

## Programmatic API

```js
const { createTicketStore } = require('@openclaw-frontier/tickets');

const store = createTicketStore({
  ticketsPath: 'release-gate/tickets.jsonl',
});

const evt = store.open({
  title: 'Add SLO dashboard',
  by: 'operator',
  priority: 'p1',
  slaHours: 72,
});

store.claim({ id: evt.ticketId, by: 'builder' });
store.requestReview({ id: evt.ticketId, by: 'builder', reviewer: 'reviewer' });
store.approveReview({ id: evt.ticketId, by: 'reviewer' });
store.close({ id: evt.ticketId, by: 'operator', resolution: 'shipped' });

const t = store.get({ id: evt.ticketId });
console.log(t.state);            // 'archived'
console.log(t.history.length);   // 4

const breaches = store.checkSlaBreaches();
const recap = store.recap({ days: 7 });
```

Errors:

- `TicketStateError` — invalid FSM transition or missing ticket.
- `TicketValidationError` — malformed input (bad agent id, missing field,
  public-safety scan failure, lock timeout).

## Hard rules

- Pure JS. No new runtime dependencies.
- Append-only JSONL. Never mutate or delete a line.
- Mandatory `by` on every transition.
- Schema version `openclaw-frontier.ticket-store.v1`. Schema bumps require a
  transformer over the old log.
- Public-safety scan applies to every event before append — same patterns as
  the blackboard ledger (home paths, private-key blocks, api token shapes,
  Telegram tokens). A scan failure throws `TicketValidationError` and the
  event is not written.

## Testing

```
node src/tickets/test/ticket-store.test.js
```

The test file exercises the FSM end-to-end (open, claim, review, approve,
request-changes, close, reopen), dependency blocking, SLA breach detection,
JSONL persistence (restart-restore), and a set of invalid-transition cases
that must throw. It is wired into `scripts/verify-package.js` as the
`ticket-store-test` check, so `npm run verify` covers it.
