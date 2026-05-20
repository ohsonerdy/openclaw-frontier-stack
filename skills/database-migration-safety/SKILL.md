---
name: database-migration-safety
description: Use when planning or executing a schema migration on a production database — adding columns, changing types, dropping fields, adding indexes, or shifting constraints without downtime or data loss. Triggers when the user mentions "database migration", "schema change", "online migration", "expand contract", "blue-green schema", "Alembic", "Flyway", "Liquibase", "gh-ost", "pt-online-schema-change", or "this migration is locking the table". The skill covers the expand-contract pattern, lock-free techniques, the online-safety filter per operation type, backfill strategy, and reversible-vs-one-way migrations. For backup and restore in case the migration goes wrong, see backup-and-restore. For the schema design that precedes the migration, see schema-design.
metadata:
  version: 0.1.0
---

# Database migration safety

A schema migration that locks the production table for two minutes during peak traffic is an incident. A schema migration that drops a column the application still reads is a worse incident. A schema migration with no rollback path is the worst kind because mitigation requires more migration, on top of the existing damage.

The discipline of safe migration is to treat every change as two questions: "will this migration cause user-visible disruption while it runs?" and "what is the rollback path if the answer turns out to be yes after we already started?" If either question doesn't have a clear answer, don't run the migration yet.

This skill covers the patterns that make migrations safe (expand-contract, online schema change tools, backfill discipline), the per-operation safety filter, and the rollback-or-explicitly-one-way decision. For the design of the schema itself, see schema-design. For data-loss recovery if a migration corrupts data, see backup-and-restore.

## When to invoke this skill

- Planning a schema change on a production database.
- Reviewing someone else's migration PR.
- Deciding whether a change needs the expand-contract pattern or can be done in one step.
- Diagnosing a stuck migration (long-running lock, replication lag, blocked queries).
- Designing the backfill for a new column that needs values for existing rows.
- Adding or dropping a constraint on a large table.
- Choosing between native migration tools (Alembic, Flyway, Liquibase) and online schema change tools (gh-ost, pt-online-schema-change).
- Reviewing a migration that's about to run during peak traffic (timing is itself a safety decision).

## The expand-contract pattern

The default pattern for any schema change that involves a code change. Three phases:

1. **Expand.** Add the new schema element without removing the old. The new table, column, or index exists; the old still does too. No code change yet; the schema is now "either shape is valid".
2. **Migrate.** Update the application to write to the new shape (and optionally still write to the old, for safety). Backfill existing data into the new shape if needed. Now the application reads and writes both shapes; the new shape is fully populated.
3. **Switch.** Update the application to read from the new shape. The old shape is still there but no longer authoritative.
4. **Contract.** Once the application is fully on the new shape and you're confident the rollback isn't needed, remove the old shape.

Each phase is a separate deploy. The deploys are independent in the sense that any phase can be rolled back without coordinating with the next.

The reasons this pattern matters:

- **No coordinated deploy.** A "deploy the migration and the code change together" pattern means either the migration runs without code, or the code runs without the migration. Both are broken. Expand-contract avoids the coordination requirement.
- **Rollback is real.** At any point between phases, the previous phase is still valid. You can rollback the code without rolling back the schema. You can rollback the schema without rolling back the code.
- **No downtime.** The application is always operating against a valid schema. The schema is always either old-only, both, or new-only — never a transitional state that's broken.

The cost: each phase is a separate deploy with its own monitoring window. For a single-step migration, this feels like overhead. For any migration with risk, the overhead is the price of safety.

## The online-safety filter

Not every schema operation is equally safe. The risk profile varies by operation and by database engine. The high-risk operations:

- **Adding a column with NOT NULL and no default.** Requires writing a value to every existing row. On Postgres < 11 and most engines, this locks the table for the duration of the rewrite. On Postgres 11+, NOT NULL columns with a default value are cheap because the default isn't materialized. Without a default, even modern Postgres rewrites the table.
- **Changing a column type.** Often requires a table rewrite. The exception is type changes that are binary-compatible (e.g., varchar(50) -> varchar(100) on Postgres is metadata-only). Type changes that aren't binary-compatible are full rewrites.
- **Adding a check constraint.** Default behavior is to validate against every existing row, locking the table. The safer approach: add the constraint as NOT VALID first (fast, no lock), then VALIDATE CONSTRAINT separately (slower but doesn't take an exclusive lock on Postgres).
- **Adding a foreign key constraint.** Similar to check constraints. Adding with NOT VALID + VALIDATE separately avoids the long exclusive lock. Foreign key validation still costs IO but doesn't block writes.
- **Adding a unique index.** Locks the table for the duration of the index build, unless you use CREATE INDEX CONCURRENTLY (Postgres) or its equivalent.
- **Dropping a column.** The metadata change is fast, but if any code path still reads the column, you've created an error storm. The safe pattern is expand-contract: stop reading the column first (deploy), wait for confirmation, then drop.
- **Renaming a column.** Same as dropping. Any code path that reads the old name breaks. Default to the expand-contract pattern: add new column with new name, dual-write, switch reads, drop old.

The shorter list of operations that are reliably safe on a hot table:

- **Adding a nullable column with no default.** Metadata-only on Postgres. Cheap.
- **Adding a column with default that's NULL-aware.** Postgres 11+ for default-as-metadata.
- **Creating an index CONCURRENTLY.** Slow but non-blocking.
- **Adding a constraint as NOT VALID, then validating separately.** Two-step but no long lock.

The filter for any proposed migration: walk through the operation and ask "does this take an exclusive lock for longer than a heartbeat?" If yes, route through online schema change tools or break the operation into the expand-contract steps.

## Lock-free migration techniques

For operations that natively take long locks, online schema change tools rewrite the table in the background while shipping write deltas. The two production-grade options:

- **gh-ost (GitHub's online schema migration).** Reads the binary log to replay writes against a shadow table. Cuts over at the end with a brief lock. Pure-replication-based; no triggers required.
- **pt-online-schema-change (Percona Toolkit).** Uses triggers on the original table to copy writes into a shadow table during the migration. Cuts over at the end with a brief lock.

Both produce the same end state: a rewritten table with the new schema, with replication and writes preserved during the migration. Choose based on operational familiarity; both work.

For Postgres, the equivalent tools (pg_repack, pg-online-schema-change) exist but are less mature. The default Postgres tactic for table rewrites is to use the expand-contract pattern rather than online schema change tools.

The shared pattern: the migration runs alongside production traffic, takes a brief lock at cutover, and is reversible up to the cutover point.

The cost of online schema change tools: they take longer (often hours for large tables), generate replication lag, and require throttling to avoid overloading the replica. The migration is a controlled, monitored operation, not a single command.

## Backfill strategy

When you add a column that needs values for existing rows, the backfill is its own migration. Done naively (one big UPDATE), the backfill locks the table or generates massive replication lag.

The safer pattern:

- **Batch by primary key range.** Update 1000 to 10000 rows at a time. Smaller batches mean less lock contention and less replication lag per batch.
- **Throttle between batches.** Sleep between batches to allow replicas to catch up. Tune the sleep against actual replication lag, not an arbitrary value.
- **Monitor replication lag.** Throttle the backfill in real-time based on lag. If lag exceeds a threshold, pause. Resume when lag drops.
- **Idempotent.** The backfill should be safe to re-run. If a batch fails halfway, re-running shouldn't double-count.
- **Resumable.** Track progress (last PK processed) so a paused or crashed backfill can resume from where it left off, not from the start.
- **Background, not application-blocking.** Run the backfill from a separate worker or job, not from the request path.

The backfill is often the slowest part of a migration. For a billion-row table, a properly throttled backfill might take days. That's fine; the table is still serving traffic the whole time.

A specific anti-pattern: running the backfill as a single UPDATE on the entire table. This locks the table, generates massive replication lag, and if it crashes you have no way to know how far it got.

## Rollback planning

Every migration is either reversible or explicitly one-way with sign-off.

- **Reversible.** The "down" migration restores the previous schema. Adding a column is reversible (drop it). Adding an index is reversible (drop it). Adding a constraint is reversible (drop it).
- **One-way.** Dropping a column is one-way once the data is gone. Changing a column type with data loss (truncating long strings, casting float to int) is one-way. Drop-and-recreate-with-different-shape is one-way.

For one-way migrations, two requirements:

- **Explicit sign-off.** The PR mentions "this is a one-way migration" and identifies what's being lost. A reviewer who didn't notice the irreversibility is a process failure.
- **Backup-verified.** A backup taken immediately before the migration, verified to restore (not just verified to exist). The backup is the rollback path. See backup-and-restore.

The default bias is reversibility. If you can find a way to make the migration reversible (expand-contract, soft delete instead of drop, type widening instead of narrowing), choose that path. Irreversibility is a property to be paid for, not assumed.

The down-migration is not just "code that drops the column"; it's "code that has been tested against a copy of production". An untested down-migration is hope, not a rollback.

## Foreign key constraint additions

Adding a foreign key to a large existing table is a special case worth calling out.

- The constraint validates against every existing row. On Postgres, this acquires a ShareRowExclusiveLock — blocks writes for the duration.
- The safer pattern: ADD CONSTRAINT ... NOT VALID, then VALIDATE CONSTRAINT in a separate transaction.
- ADD CONSTRAINT NOT VALID acquires a brief AccessExclusiveLock (metadata change). VALIDATE acquires a ShareUpdateExclusiveLock (allows reads and writes, blocks DDL).
- The new constraint applies to new writes immediately; the validation step retroactively confirms existing rows.

The two-step pattern is the default for any constraint added to a large table. The naive single-step version causes downtime.

## Production-data-shaped test

Migrations should be tested against a production-data-shaped copy, not just against an empty staging database.

- The empty database hides timing issues. The migration that runs in 200ms on empty data takes 2 hours on production-scale data.
- The empty database hides lock contention. The migration that doesn't conflict with anything in staging conflicts with live writes in production.
- The empty database hides replication lag. The migration that doesn't generate lag in staging generates hours of lag in production.

The test is to run the migration against a recent restore of production data (privacy-scrubbed if required) and measure:

- How long does it take?
- What locks does it acquire, and for how long?
- How much replication lag does it generate?
- Does the rollback work?

For a production-scale system, this test is itself a multi-hour exercise. That's fine; it's cheaper than the incident.

## Migration timing

The migration's wall-clock time matters less than the timing of when it runs.

- **Off-peak windows.** Run during the lowest-traffic period. The same migration that's fine at 3am may be an incident at noon.
- **Not during a deploy freeze.** Migrations during freeze periods (Friday afternoon, week of a major launch) increase the on-call risk. Default to no migration during freeze unless explicitly authorized.
- **Not during a known maintenance event.** Coordinating two changes (migration + dependency upgrade + traffic shift) compounds risk.
- **With a defined abort point.** If the migration is going to exceed its expected window, the on-call has authority to abort. Define the abort criteria in advance; don't make it up at 4am.

For long migrations (hours to days), the timing is the start time; the migration itself runs continuously. The on-call's job is to monitor, throttle, and abort if the migration is causing user-visible issues.

## Migration tooling

The choice of migration tool determines a lot of the operational behavior:

- **Framework-native (Alembic for SQLAlchemy, ActiveRecord migrations, Django migrations).** Couples migrations to the application's schema definition. Useful for development; dangerous in production because the tool's defaults are not always online-safe. Read what the tool actually does for each operation.
- **Database-native (Flyway, Liquibase).** Tool-agnostic SQL files. More explicit, less magic. The team writes the actual SQL, including the safety pattern.
- **Online schema change (gh-ost, pt-osc, pg_repack).** Used for the specific operations that need lock-free behavior. Sit alongside the framework migration, not in place of it.

The recommendation: use the framework migration tool for the changes that are safe by default, and the online schema change tool for the changes that aren't. Mixing is normal; pretending one tool covers all cases isn't.

## Common anti-patterns

- **One-step migration with code change in the same deploy.** Either the migration runs without code, or the code runs without the migration. Both are broken. Use expand-contract.
- **NOT NULL with no default on a large table.** Locks the table for a rewrite. Add as nullable, backfill, then add NOT NULL.
- **Dropping a column without first stopping reads.** Code that still reads the column breaks immediately at the drop.
- **One UPDATE for the entire backfill.** Locks the table, generates massive lag, crashes leave you blind.
- **No rollback plan because "we'll just roll forward".** Sometimes roll-forward works; often the system is too broken to roll forward safely.
- **Untested down-migration.** The down is theoretical until you run it against production-shaped data.
- **Adding a foreign key constraint without NOT VALID + VALIDATE.** Blocks writes during the validation scan.
- **Running migrations during peak traffic without reason.** The 3am off-peak window exists for a reason.
- **Migration that takes 2 hours but nobody is monitoring it.** Long migrations need active monitoring; the on-call has to be paying attention.
- **No production-data-shaped test.** The empty staging database lies about performance and lock behavior.

## Output format

When this skill is invoked to plan or review a migration, structure your output as:

1. **Operation classification.** What schema operation, on which table, with what scale.
2. **Online safety verdict.** Safe-as-written, or requires expand-contract, or requires online schema change tool.
3. **Phase plan.** If expand-contract, the steps with their order and deploy boundaries.
4. **Backfill plan.** Batch size, throttle, monitoring criteria, resumability.
5. **Rollback plan.** Reversible (with down-migration tested) or explicitly one-way (with backup verified).
6. **Timing window.** When to run, abort criteria, who's on-call during the migration.
7. **Test plan.** Production-data-shaped test before the real run.
8. **Monitoring.** What to watch (lock duration, replication lag, application errors, query latency).

## Related skills

- `schema-design` — the design that precedes the migration. A migration is a change to a schema; the schema's quality determines what the migration has to do.
- `backup-and-restore` — the rollback path for one-way migrations. Backup-verified is the precondition for irreversibility.
- `safe-public-release` — the broader release-gate workflow that migrations live inside.
- `incident-response` — when a migration becomes an incident, the playbook applies.
- `monitoring-and-alerting` — the metrics that signal a migration is causing user impact (lock duration, replication lag, error rate spike).
- `postdeploy-verification` — after the migration deploys, verify it actually did what it claimed (counts, sample reads, application errors).
- `feature-flagging` — when the application code that depends on the migration is flagged, the rollout decouples from the migration.
