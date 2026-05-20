# Tickets

Agent ticketing FSM that sits beside the blackboard ledger and taskflow runtime.
Whereas the blackboard tracks per-project operational state and taskflow tracks
in-flight goal execution, tickets are the repo-wide, persistent record of
"work that exists" — from open queue to archive.

States: `open -> in-progress -> review -> done -> archived` (archived terminal).
Plus a derived `blocked` flag when at least one open dependency is unmet.

Storage: append-only JSONL at `release-gate/tickets.jsonl` by default
(override via `OPENCLAW_TICKETS_PATH` or `--tickets-path`).

See `docs/ticketing.md` for the operator guide.

## Run test

```bash
node src/tickets/test/ticket-store.test.js
```
