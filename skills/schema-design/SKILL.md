---
name: schema-design
description: Use when designing a new database schema (relational or NoSQL) or changing one safely under production load. Triggers when the user mentions "design the schema", "what tables do I need", "database design", "normalization", "denormalization", "index design", "primary key choice", "schema migration", "soft delete", or "JSON column". The output is a schema you can ship and a migration plan that won't lock the production database. For the API surface that sits on top, see api-design. For capturing the resulting decisions, see architecture-decision-records.
metadata:
  version: 0.1.0
---

# Schema design

Schema design has a longer half-life than almost any other code you write. Application code gets rewritten every few years; the schema underneath survives, accumulating cruft, indexes, and migrations. The schema you design today will still be live when several generations of engineers have come and gone.

This raises the cost of getting it wrong and rewards thinking carefully up front. It also rewards designing for evolution — the schema needs to absorb changes you cannot anticipate.

## Step 1: workload before schema

The single most common schema-design mistake is starting from the data and ignoring how it will be queried. Schema is shaped by queries, not the other way around.

Before drawing tables, document the workload:

- **Read patterns.** What queries does the application make? What's the QPS for each? What's the latency tolerance? What's the result size?
- **Write patterns.** Insert rate, update rate, delete rate. Are writes batched or per-request? What's the latency tolerance for writes?
- **Consistency requirements.** Read-your-writes? Strong consistency across queries? Eventual consistency tolerable?
- **Concurrency profile.** Lots of writers to the same row? Mostly reads? Heavy aggregation queries that touch many rows?

The workload determines whether relational or NoSQL is appropriate, what to denormalize, where indexes go, and what consistency model fits.

A schema designed without the workload in mind is academic. It will be elegant on paper and slow in production.

## Step 2: relational vs NoSQL

The decision is concrete, not philosophical.

### Relational (Postgres, MySQL, etc.)

Best when:
- The data has meaningful relationships across entities.
- Queries are unpredictable or evolve over time.
- ACID semantics are needed (financial data, anything where partial-write is unacceptable).
- Joins are normal, not pathological.
- The data fits comfortably on a single primary (or a single read-write tier with replicas).

Avoid when:
- The workload is single-key lookup at huge scale (millions of QPS) and joins are unused.
- The data is naturally append-only event streams.
- Horizontal write scaling is a hard requirement from day one.

### Document NoSQL (MongoDB, DynamoDB document mode)

Best when:
- Each document is mostly read/written as a unit.
- The data model is hierarchical (the document IS the natural unit).
- Schema evolves rapidly and migrations are painful.
- Joins are rare or always done at the application layer.

Avoid when:
- The application makes ad hoc analytical queries.
- Data has many-to-many relationships.
- Strong consistency across documents is required.

### Key-value (DynamoDB, Redis as primary)

Best when:
- Access patterns are known up front and don't change.
- Single-key or simple-range lookups dominate.
- Scale is the primary constraint.
- The team is comfortable designing the keys as the access pattern.

Avoid when:
- The access pattern will evolve significantly.
- Ad-hoc query needs are likely.

### Column-store / time-series

Best when:
- Analytical queries over large ranges.
- Append-heavy workloads.
- Time-bucketed aggregations dominate.

The decision is rarely "either / or". Many production systems use multiple: relational for the OLTP core, a column store for analytics, key-value for hot caches. Pick the right tool for each workload rather than forcing one model everywhere.

## Step 3: normalization and when to break it

For relational schemas, the normalization rules are tools, not laws.

- **1NF.** Each cell holds one value. No comma-separated lists in a column, no JSON arrays masquerading as relations.
- **2NF.** Non-key columns depend on the entire primary key, not just part of it. Mostly matters for composite-key tables.
- **3NF.** Non-key columns depend on the primary key, not on other non-key columns. Removes transitive dependencies.

The bar for staying normalized: if a fact lives in exactly one place, you can change it once. If a fact is denormalized into multiple places, every change requires updating all copies, and any miss creates inconsistency.

When to deliberately denormalize:

- **Read-heavy queries that touch many tables.** If the hot path joins five tables on every request, materializing the join into a single denormalized read table can be worth the write cost.
- **Reporting / analytics workloads.** Star/snowflake schemas denormalize for query speed; this is expected.
- **Audit trails and historical records.** A snapshot of "what the user's name was when they placed this order" is denormalized intentionally, because user names change but the order should preserve the historical value.

The discipline: every denormalization needs a documented reason and a documented update path. A denormalized field whose update path is "I think the trigger handles it" is a bug waiting to happen.

## Step 4: primary key selection

The PK choice has consequences far beyond uniqueness.

### Sequential integer (auto-increment)

Pros: small storage, fast inserts (writes hit the tail of the index), human-readable.
Cons: leaks count over time (competitors can see growth), creates hotspots in some replication setups, requires database round-trip to assign.

Default for internal-only relational tables where leaking row count doesn't matter.

### UUID v4 (random)

Pros: client can generate without a round-trip, doesn't leak count, globally unique across shards.
Cons: 16 bytes vs 4–8 for an integer, fragments the index because inserts go to random positions, less cache-friendly.

Default when the PK is exposed publicly or when distributed write generation matters.

### UUID v7 (time-ordered)

Pros: UUID benefits plus time-ordered insertion (better index locality).
Cons: leaks creation time, less mature library support than v4.

A reasonable middle ground when you want both stability and index locality.

### Composite key

Pros: encodes the relationship naturally in the PK, prevents duplicates without a separate constraint.
Cons: foreign keys to the table need all the PK columns, harder to refactor later.

Use for join tables and tables where the natural key is genuinely composite.

### Natural key (email, username, etc.)

Pros: no separate ID needed, natural for some queries.
Cons: natural keys change. Email changes. Username changes. When the PK changes, every foreign key needs to update.

Almost always wrong to use a mutable natural key as the PK. The exception is when the natural key is provably immutable in your domain (e.g. a country ISO code, a fixed product SKU).

The trap: starting with a natural key because it's expedient, then having to change all the FKs when the natural key turns out to be mutable. The cost of a surrogate key is one column; the cost of the wrong PK is a major migration.

## Step 5: foreign keys and cascades

Foreign keys enforce referential integrity at the database level. They prevent orphan rows; they catch bugs in application code; they document relationships.

Decisions:

### Use FK constraints or rely on application logic?

For relational stores, default to using FK constraints. The application is not the only writer (ad-hoc fixes, migrations, batch jobs). The constraint catches the cases the application logic misses.

The exception is at very high write rates where the FK check itself becomes a bottleneck — rare, and usually means you're using the wrong store.

### Cascades

`ON DELETE CASCADE` automatically deletes child rows when the parent is deleted. Convenient. Also dangerous.

- **Use CASCADE** for rows that have no meaning without the parent: comments on a deleted post, line items on a deleted order, child preferences on a deleted user.
- **Avoid CASCADE** for anything that has independent meaning or audit value: don't cascade-delete payment records when a customer is deleted; that erases history you might need.
- **Never CASCADE across loosely-coupled domains.** If deleting one entity silently affects an unrelated subsystem, you have a hidden coupling.

`ON DELETE RESTRICT` (the default in some systems) is safer — the delete fails if there are child rows, forcing the application to deal with them explicitly.

`ON DELETE SET NULL` is occasionally useful but requires the FK column to be nullable, which has its own design cost.

## Step 6: nullable columns

Nullable is the single most underdesigned property of a column.

A nullable column means: "this attribute may be unknown or not applicable". That's a real semantic; sometimes it's the right answer. But default-to-nullable is a habit that obscures the real model.

- **Required-at-creation fields.** `NOT NULL`. The application can't even create the row without this.
- **Optional fields with a meaningful default.** `NOT NULL DEFAULT <value>`. The default expresses the "unknown" state explicitly.
- **Truly unknown / not-applicable fields.** `NULL`. Used sparingly, with a comment explaining when NULL is expected.

The trap: NULL collapses several different meanings (missing, not yet known, not applicable, deliberately omitted). When a column is nullable, queries have to handle the NULL case, and the application has to interpret what NULL means. Often you actually want a separate flag or a tristate enum.

## Step 7: index design

Indexes are not magic; each one has a write cost and a storage cost. The rule: design indexes from the read patterns, not from a generic "add an index on every foreign key".

For each frequent query:

1. Identify the columns in the WHERE clause and the ORDER BY clause.
2. Design a composite index that covers the WHERE columns first, then the ORDER BY columns.
3. If the query reads a small fixed set of columns, consider a covering index (include the read columns so the table doesn't have to be hit).

For each index, justify the write cost. If the column is rarely queried, the index is just deadweight.

Common index mistakes:

- **Indexing every column individually instead of composite.** Most queries need multi-column selectivity; single-column indexes can't combine optimally.
- **Indexing low-cardinality columns alone.** A boolean column index rarely helps; combine with other columns.
- **Forgetting that order matters in composite indexes.** An index on `(user_id, created_at)` cannot serve a query that filters on `created_at` alone.
- **Indexing columns that change frequently.** Every update rewrites the index; high-churn columns are expensive to index.
- **Not measuring index usage.** Postgres has `pg_stat_user_indexes`; MySQL has `index_statistics`. Unused indexes are pure overhead — measure and prune.

## Step 8: soft delete vs archive table

Soft delete (a `deleted_at` timestamp column, with queries filtering `WHERE deleted_at IS NULL`) is convenient but has costs:

- Every query has to remember the filter, or queries silently include deleted rows.
- Indexes have to be designed with the filter in mind (partial indexes, or `deleted_at IS NULL` in every index).
- Storage grows monotonically; soft-deleted rows still occupy space.
- Compliance: if you need to delete data for regulatory reasons (GDPR, etc.), soft delete is not deletion.

Archive table (move deleted rows to a separate `<table>_archive` with a timestamp) is more work but has clearer semantics. The live table only has live rows; the archive is for history. Compliance deletion can run against the archive separately.

For most workloads, soft delete is fine for short-lived "deletion is reversible" data (drafts, comments). Archive tables are better for long-lived audit-relevant data (orders, transactions).

Decide explicitly; don't drift into soft-delete-everywhere by default.

## Step 9: JSON columns in relational DBs

Modern Postgres and MySQL support JSON columns with indexing. They're tempting and often misused.

Good fits for JSON columns:

- Genuinely unstructured user data (settings, preferences, custom fields).
- Schema-on-read for data ingested from external sources with varying shapes.
- Sparse attributes where the relational alternative would be many nullable columns.

Bad fits:

- Hiding a fixed schema to "move fast". JSON columns make migrations harder, not easier — there's no schema constraint, so bad data accumulates.
- Storing relational data. If two JSON fields routinely need to be joined, they should be separate tables.
- Avoiding the discipline of column design. JSON makes the schema invisible to the database; the schema lives in application code, where it's harder to enforce.

The test: would I add this as a regular column if I were sure about the shape? If yes, add it as a regular column. If no — if the shape genuinely varies — then JSON.

## Step 10: schema migration safety

Schema changes on a live database can lock tables, block reads or writes, and cause cascading timeouts. Migration safety is its own discipline.

### Safe migrations (no exclusive lock)

- Adding a new nullable column.
- Adding a new column with a constant default in Postgres 11+ (older versions rewrite the table).
- Creating an index `CONCURRENTLY` in Postgres.
- Adding new tables.
- Dropping unused indexes (after verifying they're unused).

### Risky migrations

- Adding a non-nullable column without a default (requires the table to be rewritten or the column to be filled atomically — usually means a multi-step migration).
- Adding a FK constraint to an existing table with data (locks, validation cost).
- Adding a NOT NULL constraint to an existing nullable column (requires backfill + validate).
- Changing a column type when the new type isn't binary-compatible.
- Renaming a column (clients may break; usually best to add new + dual-write + drop old).

### The standard pattern for risky changes

1. **Add the new shape alongside the old shape.** New column, new table, new constraint not-yet-enforced.
2. **Dual-write.** Application writes both old and new shapes for a defined window.
3. **Backfill.** Migrate existing rows from old to new shape.
4. **Switch reads to new shape.** Application starts reading from the new shape.
5. **Stop dual-writing.** New shape becomes the source of truth.
6. **Drop the old shape.** Only after monitoring confirms no clients depend on it.

This is slower than a single ALTER TABLE but does not require downtime. The cost of getting it wrong (production database locked for an hour during a migration) is high enough that the slower process pays off.

## Common anti-patterns

- **Designing tables without consulting the application code that will query them.** Workload first.
- **Single "metadata" JSON column on every table.** Schema-by-convention is not schema.
- **Foreign keys without indexes on the FK column.** Cascades and lookups scan the table.
- **Optimistic locking via `updated_at` only.** Two updates in the same millisecond clobber each other. Use a version column.
- **Storing money as a float.** Always use a decimal type with explicit precision.
- **Storing timestamps without timezone.** Always store UTC; let the application render local time.
- **Boolean columns for tri-state.** "active", "deleted", "suspended" is three states, not three booleans.

## Output format

When this skill is invoked, produce:

1. **Workload summary** — read/write patterns, consistency, concurrency.
2. **Store choice** — relational / document / key-value / column-store with justification.
3. **Table list** — for each table, the PK choice, the column list with NOT NULL and types, the FK relationships, and the cascade rules.
4. **Index plan** — for each frequent query, the composite index to add and why.
5. **Soft delete / archive policy** — explicit decision per table.
6. **Migration plan** — for changes to existing schemas, the multi-step migration pattern.
7. **Open questions** — anything that needs the workload data to confirm.

For decisions large enough to need durable recording (PK strategy, store choice, denormalization patterns), recommend an ADR.

## Related skills

- `api-design` — the API surface sitting on top. The two designs should be consistent.
- `architecture-decision-records` — capture decisions about PK strategy, store choice, and major denormalizations.
- `performance-profiling` — when query performance is the driver of denormalization, profile first.
- `monitoring-and-alerting` — schema changes need monitoring; design at the same time.
