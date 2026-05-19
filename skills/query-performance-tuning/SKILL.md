---
name: query-performance-tuning
description: Use when a database query is slow, when EXPLAIN output needs to be interpreted, when N+1 patterns are suspected, when an index is being chosen or rejected, or when the working set has grown past memory. Triggers when the user mentions "query is slow", "EXPLAIN", "EXPLAIN ANALYZE", "missing index", "wrong index", "N+1 queries", "slow query log", "p99 query latency", "we need to denormalize", "working set", "buffer cache miss", "table scan", or "the planner picked the wrong plan". The skill covers the diagnostic workflow, EXPLAIN reading, index selection, N+1 detection, the denormalize-vs-index decision, and working-set sizing. For schema design before queries get slow, see schema-design. For migrations that change schema to fix queries, see database-migration-safety.
metadata:
  version: 0.1.0
---

# Query performance tuning

A slow query usually has one of three causes: the wrong plan (the planner picked something silly because it lacked statistics or hints), the wrong access path (no index, or the wrong index for this query), or the wrong working set (the data is too large for memory and the query thrashes the disk). The diagnostic workflow distinguishes the three.

The tempting first move is to add an index. Indexes have costs (write amplification, storage, more options for the planner to pick badly), so the diagnostic should come first. The right index makes a query fast; the wrong index makes the table slow on writes for no benefit on reads.

This skill covers the diagnostic workflow, how to read EXPLAIN, how to choose indexes, how to recognize N+1 patterns, and the decision between denormalizing and indexing. For the schema design that precedes queries, see schema-design. For the migrations that change schema, see database-migration-safety.

## When to invoke this skill

- A specific query is slow and you need to figure out why.
- EXPLAIN output is opaque and needs interpretation.
- Choosing between adding an index, restructuring the query, or denormalizing.
- Reviewing a PR that adds an index.
- Diagnosing N+1 patterns in an ORM-heavy codebase.
- Working-set has grown and the database is doing more disk reads than expected.
- The planner picked the wrong plan and you're considering hints or statistics updates.

## The diagnostic workflow

Before adding any index, run the diagnostic. Four steps, in order.

1. **Confirm the query is actually slow.** Get the p50, p95, p99 latency from the slow-query log, the APM trace, or the application's query timing. A query that's slow in the dev environment but fast in production may not be the right target.
2. **Capture the actual plan.** EXPLAIN ANALYZE (Postgres), EXPLAIN ANALYZE FORMAT JSON (MySQL), or the equivalent. Capture with realistic parameter values, not generic placeholders — the plan changes based on parameters.
3. **Read the plan.** The plan tells you what the database is actually doing: sequential scans, index scans, joins, sorts, aggregations. The slowest node in the plan is where the time goes.
4. **Form a hypothesis.** Why is the slow node slow? Wrong plan, wrong access path, or wrong working set? Each has a different fix.

Anti-pattern: skipping steps 2 and 3 and going straight to "add an index". You add the wrong index, the planner doesn't use it, and the query is still slow.

## Reading EXPLAIN

EXPLAIN output is verbose. Focus on the nodes that dominate the runtime. A few key things to read for in Postgres-style output:

- **Sequential scan vs index scan.** Sequential scan reads every row in the table. Acceptable for small tables (under 10000 rows usually). Unacceptable for large tables in latency-sensitive queries.
- **Rows estimated vs rows actual.** The planner estimates how many rows each node will produce. If estimates are off by more than 10x, the planner is making bad decisions because its statistics are stale or its model is wrong.
- **Filter rows removed.** A node that processes 1 million rows and emits 100 has done 1 million rows of work for 100 rows of output. The filter is happening too late; push the predicate down or use an index.
- **Sort node with a high cost.** Sorts that don't fit in memory spill to disk. A "Sort Method: external merge" is a sign of spilled sort.
- **Hash join with a large hash table.** Hash joins build a hash on the smaller relation; if the smaller relation is still large, the hash spills.
- **Nested loop on a large outer.** A nested loop is fast if the outer relation is small. With a large outer, each row drives a lookup and the cost is multiplicative.

For MySQL, the analogous signals: `type` column (ALL is sequential scan, ref/range/eq_ref are index scans), `rows` column (estimated rows examined), `Extra` column ("Using filesort", "Using temporary"), `key` column (the index actually used).

The reading is: start at the bottom (innermost node), trace up, and find the node where the actual time is concentrated.

## Three failure modes

Most slow queries fall into one of three buckets.

### Wrong plan

The planner picked something suboptimal. Symptoms: estimates very different from actuals, a sequential scan where an index exists, a nested loop where a hash join would be faster.

Causes:

- **Stale statistics.** ANALYZE has not been run recently; the planner's row estimates are out of date. Re-run ANALYZE.
- **Parameter sniffing.** The plan was cached for a different parameter value; the cached plan is wrong for the current value. Force a re-plan or use a hint.
- **Bad cardinality estimates.** The planner's model doesn't capture skew (one customer with 10 million orders, every other customer has 10). Use extended statistics, multi-column statistics, or partitioning.
- **Planner limitations.** Some plan shapes are not reachable by the planner. The fix is usually a query rewrite (subquery to join, EXISTS to JOIN, OR to UNION ALL) or a hint if the database supports them.

The fix is rarely an index in this case; it's a stats update or a query rewrite.

### Wrong access path

The query is doing the right shape of work but on the wrong data structure. Symptoms: sequential scan on a large table when the predicate is highly selective, index scan that visits the heap for every row because the index is not covering, hash join that builds a hash on a non-trivial source.

Causes:

- **No index on the filter column.** Add an index. Single-column index on the most selective predicate.
- **Wrong order in a composite index.** Postgres and MySQL composite indexes are usable only if the leading column is a constant. An index on `(status, created_at)` does not speed up a query that filters on `created_at` alone.
- **Non-covering index.** The query needs columns not in the index, so the database reads from the heap for every match. Add the columns to the index (INCLUDE in Postgres, prefix-extended in MySQL).
- **Wrong index for the query shape.** A B-tree index doesn't help range queries on a non-leading column; a GIN/GIST index is needed for JSON or array searches; a partial index helps for highly skewed predicates.

The fix is an index, but the right index — not any index.

### Wrong working set

The data the query touches doesn't fit in memory. Symptoms: disk reads dominate the wait time, buffer cache hit ratio is low, query is fast right after a similar query (warm cache) and slow otherwise (cold cache).

Causes:

- **Table or index larger than memory.** No amount of index tuning fixes this; the database has to read from disk.
- **Working-set drift.** The total dataset is much larger than memory, and queries hit different parts of it. Cache thrashing.
- **Index bloat.** Indexes that have accumulated stale entries; the index is larger than it should be and exhausts memory.

Fixes:

- **More memory.** Sometimes the cheapest fix is to size up the instance. If the working set is 80GB and the instance has 32GB, no amount of indexing reaches the disk-bound queries.
- **Partition.** Split the table by date or by tenant; queries only touch the partitions they need; working set per query is smaller.
- **Denormalize.** Materialize the answer to the slow query into a separate table. The trade-off is write amplification.
- **Archive.** Move old data out of the hot table to a separate cold-storage table. The hot table is smaller, fits in memory.
- **Vacuum and reindex.** Index bloat is reclaimable. VACUUM FULL on Postgres, OPTIMIZE TABLE on MySQL.

## Index selection

When an index is the right answer, pick the right one.

- **Predicate selectivity.** Index columns used in WHERE that have high selectivity (the predicate narrows the result significantly). An index on `is_active` (50% true) is much less useful than an index on `email` (unique).
- **Leading column matters.** Composite indexes work for queries that filter on the leading column or on a prefix of the columns in order. `(a, b, c)` works for `a`, `a + b`, `a + b + c`, but not for `b` alone or `c` alone.
- **Sort-friendly composite.** If the query is `WHERE status = 'active' ORDER BY created_at DESC LIMIT 20`, an index on `(status, created_at DESC)` lets the database return rows in order without a sort.
- **Covering with INCLUDE.** If the query reads only a few columns, INCLUDE those columns in the index so the database doesn't visit the heap. Postgres-specific; analogous in other engines.
- **Partial index for skew.** If 99% of rows have `is_deleted = false` and queries always filter on `is_deleted = false`, a partial index `WHERE is_deleted = false` is smaller and faster. Be careful: the predicate has to match exactly.

Indexes have costs:

- Every write updates the indexes; an index that's not used is pure overhead.
- Indexes consume buffer cache.
- The planner can pick an unhelpful index if it has too many to choose from.

The principle: add the smallest index that supports the query, not the most comprehensive one.

## N+1 detection

N+1 is the pattern where one query returns N rows and the application then issues one query per row to fetch related data. Total: 1 + N queries instead of 1 or 2.

Symptoms:

- The slow-query log shows many identical queries with different parameter values, fired in close succession.
- The APM trace shows a request that fires 500 queries, mostly identical except for an ID parameter.
- The ORM's debug log shows lazy-loaded relationships firing on iteration.

Fixes:

- **Eager loading.** Tell the ORM to fetch the related data in the same query (JOIN) or in a second batch query (WHERE id IN (...)). SQLAlchemy: `joinedload` or `selectinload`. Django: `select_related` or `prefetch_related`. Active Record: `includes`.
- **Manual batch fetch.** Issue one query for the parents, then one batched IN query for all the children. Two queries instead of N+1.
- **Cache the lookup.** If the lookup is to a small dimension table, cache it in the application and skip the database hit.

Anti-pattern: ignoring the slow-query log because each individual query is fast. The N+1 pattern is many fast queries adding up to a slow request. The total request latency is the right unit.

## Denormalize vs index

When an index can't make a query fast enough (or the query crosses too many tables for a single index), denormalization is the next move.

Denormalization options:

- **Computed column.** Add a column that stores a precomputed value (e.g., a count, a sum, a flattened JSON path). Maintained via trigger or application logic.
- **Materialized view.** A precomputed query result, refreshed on a schedule or on write. Postgres MATERIALIZED VIEW, or application-managed.
- **Read replica with different shape.** A secondary store optimized for read patterns (cache, search index, OLAP store). The transactional store stays normalized; the read store is denormalized.

The cost of denormalization is consistency. The denormalized data can lag the source of truth. The pattern is acceptable when:

- The query latency requirement is tight (the join is too slow even with indexes).
- The read-to-write ratio is high (the denormalized data is read many times per write).
- The staleness window is acceptable (the user can see slightly old data, or the refresh is fast enough).

The decision rule: try indexes first. If indexes can make the query fast, the maintenance cost of an index is much lower than the maintenance cost of denormalized data. Denormalize only when indexes are insufficient.

## Working set sizing

The working set is the portion of the database actively read and written. It should fit in memory for hot queries to be fast.

Sizing:

- **Hot table + hot index size.** Sum the sizes of the tables and indexes touched by hot queries (the ones served at p50 latency). This is the working set.
- **Buffer cache.** Configure the database's buffer cache to be larger than the working set. Postgres `shared_buffers` typically 25-40% of RAM; OS cache provides another layer.
- **Memory headroom.** Leave 20-30% headroom for sort spills, hash joins, and connection memory.

When the working set exceeds memory:

- p99 latency degrades sharply (cache misses, disk reads).
- The slow-query log lights up.
- Disk I/O becomes the bottleneck.

The fix is to shrink the working set (archive, partition, denormalize) or grow memory.

Anti-pattern: assuming the working set is small because the dataset is small. A 100GB dataset with hot queries that touch 5GB has a 5GB working set, not 100GB. Conversely, a 100GB dataset with queries that random-access across all of it has a 100GB working set, even if only 5GB is "live data".

## Common anti-patterns

- **Adding an index without reading EXPLAIN.** The planner may not use it; the writes pay the cost.
- **Adding many indexes "just in case".** Each one slows writes; the planner has more bad choices to pick from.
- **Tuning the query by reordering clauses.** SQL is declarative; clause order in WHERE does not affect the plan (in most cases).
- **Optimizing on staging data and shipping to production.** The plan changes with data volume and distribution.
- **Ignoring N+1 because each query is fast.** Request latency is the unit, not per-query latency.
- **Denormalizing before indexing.** Denormalization has higher maintenance cost than indexing; try indexing first.
- **Treating EXPLAIN ANALYZE on a development database as production-representative.** The plan and the timing depend on data volume, statistics, and cache state.
- **Forgetting to ANALYZE after a large data change.** The planner uses stale statistics; estimates are off; plans are bad.
- **Adding an index without checking write amplification.** A hot write table with five indexes does five extra writes per insert.

## Output format

When this skill is invoked to diagnose a slow query, structure the output as:

1. **Confirm the query and latency.** Slow-query log entry or APM trace.
2. **Capture the plan.** EXPLAIN ANALYZE with realistic parameters.
3. **Identify the slow node.** Where in the plan is the time concentrated.
4. **Classify the failure mode.** Wrong plan, wrong access path, or wrong working set.
5. **Propose a fix.** Stats update, query rewrite, index, partition, denormalize, or memory.
6. **Validate.** Re-run EXPLAIN ANALYZE after the fix; confirm the slow node is now fast.
7. **Watch the writes.** If you added an index, check write latency for regression.

## Related skills

- `schema-design` — the design that precedes the queries. A query that's hard to make fast may have a schema problem.
- `database-migration-safety` — adding an index on a large hot table is a migration that needs safety planning.
- `monitoring-and-alerting` — the slow-query alerts that catch regressions.
- `performance-profiling` — when the bottleneck is not in the database, profiling finds it.
- `load-testing` — under load, queries that look fine at low concurrency may degrade.
- `capacity-planning` — working-set sizing feeds into the capacity model.
