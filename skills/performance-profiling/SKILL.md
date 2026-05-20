---
name: performance-profiling
description: Use when finding and fixing slow code — latency, throughput, memory. Triggers when the user mentions "this is slow", "performance issue", "profile this", "memory leak", "high CPU", "latency spike", "throughput problem", "p99 is bad", or "we need to optimize". The first move is always to measure; the most common optimization failure is changing code without first measuring what was slow. For monitoring that surfaces these problems, see monitoring-and-alerting. For refactoring the bottleneck once found, see refactoring-safety.
metadata:
  version: 0.1.0
---

# Performance profiling

The discipline of performance work is: measure, find the bottleneck, fix only the bottleneck, measure again. The opposite — guessing at what's slow and changing code without measurement — is how most performance work fails. Code that looks slow often isn't; code that looks fine often is.

This skill is the operator's procedure for going from "we have a performance problem" to "we know exactly what's slow and exactly how much faster the fix made it".

## When to invoke this skill

- A specific user-visible symptom: page is slow, API endpoint p99 is bad, batch job is missing its window.
- A monitoring signal: latency dashboard shows regression, error rate climbs at high QPS, memory grows over time.
- Pre-launch: stress-testing a new feature under expected load.
- Architectural decisions where performance is a factor: choosing a library, designing a data path.

Do NOT invoke this skill for "this could probably be faster". Speculative optimization is the antithesis of the skill. Wait for an actual measured problem.

## Step 1: state the goal

Before profiling, state what you're optimizing for. The right answer varies:

- **Latency at the median.** What the average user feels.
- **Latency at the tail (p95, p99).** What the worst-case user feels. Often the right target for user-facing systems.
- **Throughput.** Requests per second, jobs per minute. Right target for batch and queue workers.
- **Memory footprint.** Per-process or per-request. Matters for high-density deployments.
- **Cold-start latency.** First-request after deploy. Critical for serverless and request-isolated runtimes.
- **Cost.** Sometimes "fast enough at lower compute cost" is the goal, not "faster".

State the target value too. "Faster" is not a goal; "p99 under 200ms" is. Without a target, optimization runs forever and never delivers anything shippable.

## Step 2: pick the right profiler

Different problems need different profilers. Picking the wrong one wastes hours.

### CPU sampling profiler

Samples the call stack at intervals. Shows where wall-clock time is spent in code execution.

Best for: CPU-bound bottlenecks, hot functions, algorithmic inefficiencies.

Wrong for: code that's slow due to blocking I/O, sleeps, lock waits, GC pauses.

Tools: perf (Linux), `pprof` (Go), `py-spy` (Python), `clinic flame` (Node).

### Allocation profiler

Shows where memory is allocated. Frequency, total size, allocation type.

Best for: GC pressure, memory bloat, allocation-in-hot-loops.

Wrong for: latency problems where allocations are not the bottleneck.

Tools: heap profiler in most runtimes, `pprof --alloc_objects` (Go), `tracemalloc` (Python).

### Wall-clock / block profiler

Shows where time is spent including waits — I/O, locks, sleeps.

Best for: latency problems where the function is "fast" but the request is "slow". The mismatch is usually waits.

Wrong for: pure CPU bottlenecks (the noise of I/O dominates).

Tools: `pprof --contentions` and `--block` (Go), tracing systems (Jaeger, Tempo, etc.), async-profiler in wall mode (Java).

### Distributed tracing

Spans across services. Shows where time goes in a request that crosses processes.

Best for: latency in microservices, identifying which service in a chain is slow.

Wrong for: in-process bottlenecks (a single span shows nothing inside).

Tools: OpenTelemetry, Jaeger, Tempo, AWS X-Ray.

### Database query profiler

Logs slow queries, shows query plans, identifies missing indexes.

Best for: any latency where the data layer is suspected.

Tools: `EXPLAIN ANALYZE` (Postgres, MySQL), slow query log, ORM debug logging, `pg_stat_statements`.

The single biggest profiling mistake: using a CPU sampler on a system whose problem is I/O wait. The profiler shows almost no time anywhere, you conclude "code is fine", and miss that 90% of latency is in a database round-trip.

## Step 3: measure with a baseline

A profile without a baseline is just data. The questions a profile answers are:

- **What fraction of total time is in each function?**
- **Where can I get the biggest win?**

Both require a total — total time, total memory, total request count. Capture the baseline before you start changing things:

- For latency: take a measurement representative of production load. Average over enough requests to be statistically meaningful (hundreds at minimum, thousands if variance is high).
- For throughput: maximum sustainable request rate before queue depth or latency degrades.
- For memory: steady-state RSS or heap size after warmup, plus growth rate over a defined window.

The baseline is the number every later change is measured against. Without it, you can't tell whether your "optimization" made things better.

## Step 4: Amdahl's Law as a sanity check

Amdahl: the maximum speedup from optimizing one part of a system is bounded by the fraction of total time that part takes.

If a function takes 5% of total time, making it instantly free gives at most a 5% speedup. If a function takes 60% of total time, optimizing it has up to 60% headroom.

The implication: optimize the parts that take the most time. The 5%-of-time function may have inefficient code; that's irrelevant to system performance. Save it for a code-quality pass, not a perf pass.

A common failure: a function looks slow under microbenchmark (it's allocating, it's doing math), so the engineer optimizes it. The function isn't on the hot path; the optimization changes nothing observable. The profiler would have told you immediately.

## Step 5: common slowdown taxonomy

When you have the profile, the bottleneck usually falls into one of these categories. Each has its own fix shape.

### N+1 queries

A loop that issues a database query per iteration. Symptom: many small queries in the trace.

Fix: batch the query (`WHERE id IN (...)`), preload the relations, use a join, or use an explicit eager-load. The ORM usually has the right primitive; the bug is calling the lazy path in a loop.

Detection: query count per request is high. Most modern frameworks have a debug log or APM integration that shows this.

### Blocking I/O on hot paths

Synchronous network or disk I/O on a request handler. Symptom: handler latency dominated by wait time, not CPU.

Fix: async I/O, parallel fetches (if calls are independent), or move the work off the hot path (queue, cache, materialized view).

Detection: wall-clock profiler shows time-in-wait; CPU profiler shows nothing.

### Lock contention

Multiple threads or workers waiting on the same mutex / lock / connection-pool slot. Symptom: throughput plateaus regardless of added concurrency, latency variance is high.

Fix: reduce lock granularity, replace with lock-free structures, partition the contended resource, or accept that some operations are serialized and rate-limit accordingly.

Detection: block profiler shows time in lock acquisition. Connection pool metrics show pool exhaustion.

### GC pressure

Garbage collection running too often or too long. Symptom: latency spikes correlate with GC pauses, throughput drops under load.

Fix: reduce allocation rate (object pooling, in-place mutation, struct types in some languages), adjust GC parameters (heap size, generation sizing).

Detection: GC logs, allocation profiler.

### Serialization overhead

JSON encoding/decoding, ORM hydration, protocol buffer encoding consuming significant time. Symptom: profiler shows time in encode/decode paths.

Fix: smaller payloads (filter fields), faster libraries, batch serialization, cache the serialized form if it's read more than it's written.

### Allocation in hot loops

A loop that allocates per iteration. Symptom: high allocation rate proportional to request volume.

Fix: hoist the allocation out of the loop, reuse the buffer, use a pool.

### Cache misses (in-memory or distributed)

A cache that's not actually hot. Symptom: cache hit rate is low; observed latency is the cache-miss path latency, not the cache-hit path.

Fix: warm the cache, change the eviction policy, increase the cache size, or rethink the cache key (maybe it's too specific).

### Cold path that becomes hot

Code written for a cold path is now being called frequently because of a feature change. Symptom: the same code that was fine last month is now slow, with no obvious code change.

Fix: identify the new call site, decide whether the code can be optimized in place or whether the caller should batch / cache.

## Step 6: load shape matters

The performance of a system depends on the load shape, not just the load magnitude.

- **Steady state.** Constant load over time. Easiest to optimize for; profiling at steady state reflects normal performance.
- **Burst.** Brief spikes that exceed steady-state capacity. The system has to absorb without falling over. Optimization may be about graceful degradation, not raw speed.
- **Cold start.** First request after deploy or scale-up. Latency is dominated by initialization (JIT warmup, connection pool fill, cache fill). Different optimization patterns than steady state.
- **Long-tail.** A few requests are dramatically slower than the median. Tail optimization is its own discipline; the techniques that improve p50 may not improve p99.

State the load shape you're optimizing for. Optimizing the wrong shape produces fast code that breaks under real load.

## Step 7: micro-benchmarks vs system benchmarks

Microbenchmarks measure a single function in isolation. System benchmarks measure the whole stack under representative load.

Microbenchmarks are useful for:
- Comparing algorithmic alternatives.
- Verifying that a specific change had a specific effect.
- Detecting regressions on a known-hot function.

Microbenchmarks lie about:
- What's actually slow in production (production has GC, contention, network).
- The impact of an optimization on overall system performance (Amdahl).
- Behavior under load shapes the microbenchmark doesn't simulate.

System benchmarks need representative load: real query patterns, realistic data sizes, real network latencies. Synthetic load (perfectly uniform, fully cached) measures the wrong thing.

## Step 8: optimization order

The order of optimization matters. Going in the wrong order leaves easy wins on the table while paying for expensive ones.

1. **Algorithmic improvements.** O(n²) → O(n log n) → O(n). The biggest wins. Often a different data structure or a different access pattern.
2. **Implementation improvements.** Better library, less allocation, batched calls, reduced serialization. Significant wins on hot paths.
3. **Configuration tuning.** GC, connection pool sizes, cache sizes, worker counts. Modest wins, low risk.
4. **Hardware / scaling.** More CPU, more memory, more workers. Expensive and reveals the real bottleneck if there's a non-scalable component.

Skipping step 1 is the classic mistake: throwing hardware at an O(n²) algorithm. The algorithm fix is dramatically cheaper than the hardware, and the hardware fix usually fails as scale grows.

## Step 9: when to stop optimizing

Performance work has diminishing returns. Stopping criteria:

- **Target met.** The stated goal (e.g. p99 under 200ms) is reached. Stop; ship the win.
- **Returns flat.** Each next optimization is delivering 1% or less. Switch to other work.
- **Risk-reward inverted.** The remaining optimizations require significant rewrites; the risk of regression exceeds the value of the gain.
- **Bottleneck shifted.** You optimized one part; the next bottleneck is in a different category (e.g. database, third-party). Re-profile; the work changes.

The trap: optimizing for the sake of optimizing. Performance work is fun; stopping is harder than continuing. The discipline is to ship the win and move on.

## Step 10: verify the fix

Every optimization is verified the same way it was measured:

- Same workload (the original baseline scenario).
- Same metric (latency, throughput, memory).
- Same environment (same hardware, same code paths active).
- Difference quantified: "p99 was 450ms, is now 180ms" — specific numbers.

If the verification shows less improvement than expected, the optimization didn't work as intended. Don't ship "this should be faster" — ship "this IS faster" with the measurement.

## Common anti-patterns

- **Optimizing without profiling.** Always wrong.
- **Optimizing what looks slow.** What looks slow is rarely what is slow.
- **Microbenchmark-only verification.** Microbenchmarks lie about production.
- **Throwing hardware at an algorithmic problem.** Expensive, doesn't scale.
- **Optimizing the cold path.** Wastes effort on what's not the bottleneck.
- **Skipping baselines.** Then you can't tell whether the change helped.
- **Ignoring load shape.** Synthetic load fixes synthetic problems.
- **Premature optimization in feature PRs.** Mixes the concerns. Separate perf PR.
- **Optimizing past the target.** Diminishing returns; opportunity cost.

## Output format

When this skill is invoked, produce:

1. **Goal statement** — what you're optimizing for, with a target number.
2. **Profiler choice** — which one and why, given the symptom.
3. **Baseline** — current measurement of the relevant metric.
4. **Top contributors** — from the profile, the top functions / queries / waits by fraction of total.
5. **Bottleneck classification** — which category (N+1, blocking I/O, GC pressure, etc.).
6. **Proposed fix** — specific change, expected impact.
7. **Verification plan** — how the post-fix measurement will be taken.
8. **Stopping criteria** — when the work is done.

## Related skills

- `monitoring-and-alerting` — where the symptom usually surfaces; alerting on the metric that tells you to invoke this skill.
- `refactoring-safety` — for the safe-refactor pattern when fixing the bottleneck requires structural changes.
- `schema-design` — when the bottleneck is in the data layer, the fix often goes there.
- `dependency-upgrade-safely` — sometimes the bottleneck is a slow library; upgrading or replacing is the fix.
