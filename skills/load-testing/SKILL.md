---
name: load-testing
description: Use when planning, running, or interpreting a load test — before launch, before a high-traffic event, or to verify capacity. Triggers when the user mentions "load test", "stress test", "soak test", "spike test", "capacity planning", "what's our breaking point", "Black Friday prep", "sustained traffic", or "what fails first". The skill covers load-shape selection, realistic traffic modeling, breakpoint discovery vs SLA verification, instrumentation prerequisites, and cleanup. For the post-launch performance investigation, see performance-profiling. For the alerts that surface load problems in production, see monitoring-and-alerting.
metadata:
  version: 0.1.0
---

# Load testing

A load test is a deliberate, controlled experiment that tells you how a system behaves under specified traffic — not the same thing as "the system worked when 200 users hit it that one time". The difference between a useful load test and theater is whether you can name the failure mode in advance, whether your traffic shape matches what you actually expect, and whether the system you're testing is the system you'll ship.

This skill is for designing the test, choosing the load shape, modeling traffic realistically, and interpreting results without fooling yourself. For the post-launch follow-up — investigating a slowdown that's already happening in production — use performance-profiling. For surfacing capacity problems via alerts in production, use monitoring-and-alerting.

## When to invoke this skill

- Before launching a new service that will see meaningful production traffic.
- Before a known high-traffic event (a campaign launch, a partnership-driven spike, end-of-quarter usage peak).
- After a capacity-planning question ("can we handle 5x current traffic?").
- After an incident where the system buckled under load — to verify the fix.
- When designing the production system, to validate the architecture before it ships.
- After a major dependency change (new database, new cache, new infrastructure provider) where the performance envelope is unknown.

The signal that you need a load test rather than a profile: you don't yet know what the system does under the target traffic, so you can't profile it; you have to generate the traffic to see.

## The five load shapes

Each shape answers a different question. Pick deliberately.

- **Steady load.** Constant request rate held for a long duration. Question: at this throughput, can the system maintain its SLA indefinitely? Useful for SLA verification at current capacity.
- **Ramp.** Request rate increases linearly from low to high over a window. Question: where does the system start to degrade — what's the linear-degradation point? Useful for capacity-headroom estimation.
- **Spike.** Request rate jumps suddenly from baseline to multiple-x baseline. Question: how does the system handle sudden traffic events? Are autoscalers fast enough? Does the cache cold-start cleanly? Useful for event-driven traffic (a viral moment, a flash sale).
- **Soak.** Steady load held for hours or days. Question: do resources leak over time? Does the connection pool drift? Does a slow leak surface? Useful for finding memory leaks, file descriptor exhaustion, slow queue growth.
- **Burst.** Repeated cycles of high traffic followed by quiet. Question: does the system recover between bursts? Is autoscaler thrash a problem? Useful for batch workloads, scheduled-job patterns.

A common mistake is running a single steady-load test and calling it done. Steady tells you one thing; the other shapes catch different failure modes. A system that's stable at steady 1000 rps may fall over at a spike to 1000 rps from a cold start, or may slowly leak under a 48-hour soak.

Pick the shape based on the traffic pattern you actually expect, plus one adversarial shape (usually spike or soak) to catch what you don't expect.

## Realistic traffic modeling

The traffic you generate should match the traffic you'll see. The most common load-test failure is generating one synthetic request a million times and concluding the system handles a million requests per second — when production traffic is a heterogeneous mix and the slow paths are not what you tested.

The hierarchy from worst to best:

1. **Single-endpoint hammer.** All requests are `GET /api/health`. Easy to set up; tells you almost nothing about real performance.
2. **Hand-built mix.** A handful of endpoints with a guess at the ratio. Better than (1), but the ratio is fiction.
3. **Captured ratio.** Anonymized traffic-shape data from production — endpoint mix, payload size distribution, query parameter cardinality. The traffic generator replays the ratios.
4. **Recorded traffic replay.** Actual sanitized production traffic, replayed at the target rate. The closest to real, with the caveats: dynamic data (timestamps, IDs) has to be templated; PII has to be sanitized; the recording window has to be representative.

For most teams, level 3 is the sweet spot. Recording at level 4 is best but requires the sanitization rigor.

A specific anti-pattern: testing all GETs and no writes. Writes hit different bottlenecks (DB write paths, replication, indexing, queue processing). A read-heavy load test passing tells you nothing about write capacity.

## Think-time and concurrency

A simulated user has think-time between requests. A naive load test treats every request as immediate, which inflates the apparent capacity:

- **No think-time (closed-loop saturating).** Each virtual user issues the next request as soon as the previous returns. Useful for breakpoint discovery; the absolute upper bound. Often unrealistic for user-facing systems.
- **Realistic think-time.** Each virtual user pauses 1-30 seconds between requests, drawn from a distribution. Useful for capacity planning where the question is "how many concurrent users can we serve at the SLA".
- **Open-loop (request-rate-driven).** Generator targets a request rate independent of how fast responses come. Most realistic for incoming traffic from many independent sources. If the system slows, the queue grows; this is how real overload looks.

For an external API, open-loop with realistic think-time is closest to truth. For a synchronous internal service called by another service, closed-loop matters more — the upstream service is the source of the load and it doesn't think.

## Breakpoint discovery vs SLA verification

Two different questions, two different tests.

- **SLA verification.** "At our target traffic, does the system meet its SLA (e.g. p99 latency < 200ms, error rate < 0.1%)?" Run steady load at target rate for a defined duration; measure against the SLA. Pass / fail.
- **Breakpoint discovery.** "How much traffic before the system degrades?" Ramp up until the SLA breaks. The breakpoint is the rate at which the system stops meeting its SLA, NOT the rate at which it returns errors. Pre-degradation matters more than post-degradation; a system that goes from p99=150ms to p99=2000ms is broken even if zero errors fired.

Both questions are usually worth answering. SLA verification at the current target; breakpoint to know the headroom. Headroom is the gap between current target and breakpoint — a 1.5x headroom is tight, 3x is comfortable, 10x is wasteful.

A common mistake is calling a system "passed" at SLA when it's running at 95% of breakpoint. Any traffic noise will push it over; the SLA is technically met but the system is one bad day from incident.

## The "what fails first" hypothesis

Before you run the test, write down what you expect to fail first. The candidates:

- **Database.** Connection pool exhaustion, query plan cliff, lock contention, replication lag.
- **Cache.** Cache miss storm, hot key, eviction churn, cache server CPU.
- **Application.** Thread pool exhaustion, GC pause, memory pressure, event loop lag.
- **Network.** Bandwidth saturation, TCP connection limits, DNS resolution under load, NAT exhaustion.
- **Dependencies.** Third-party API rate limit, downstream service capacity, queue backpressure.

Writing the hypothesis forces you to think about the system. Then the test result is either "expected to be the DB; was the DB" (calibrated hypothesis, productive test) or "expected to be the DB; was the cache" (you learned something).

A test where you have no hypothesis and the result is "it slowed down" is not useful — you have no insight into why. The hypothesis is the diagnostic frame.

## Instrumentation requirement

You cannot interpret a load test you cannot observe. The instrumentation requirements:

- **Application-level metrics.** Latency p50/p95/p99, error rate, request rate, throughput. Per-endpoint, not aggregated.
- **System-level metrics.** CPU, memory, file descriptors, network in/out, per host.
- **Dependency metrics.** DB connection pool usage, cache hit rate, queue depth, downstream service latency.
- **Tracing.** Distributed traces for a sample of requests so you can see where time is spent under load.
- **Logs.** Structured logs sampled at a rate that survives the load volume.

If your production observability is gappy, fix it before the load test. Running a load test against a system you cannot see is generating numbers, not learning.

The load test is also an opportunity to validate the observability — if metrics flake or dashboards lag during the test, you have a production observability problem you would have discovered the hard way.

## Same env, or very close

The system under test must be the system you'll ship. Specific risks if dev != prod:

- Smaller DB instance in dev hits its connection-pool limit at lower load than prod will. False breakpoint.
- Local network without the prod's latency, packet loss, or middlebox quirks. False latency profile.
- Different version of a critical dependency. The performance envelope can shift between minor versions.
- Missing the load balancer, the CDN, the WAF. These add latency, drop requests, change shape.

The rule: test against an environment that's the same shape as prod, ideally with the same scale (or a documented downscale ratio so you can extrapolate). A dev environment with one quarter of the cores will not predict prod behavior at full traffic.

When you cannot match prod exactly (cost, data sensitivity), document the gap explicitly. "Load test was against 1/4-scale environment; results extrapolated assuming linear scaling" is an honest qualifier; treating the dev result as prod truth is theater.

## Post-test cleanup

A load test leaves debris. Address it before walking away:

- **Test data.** Every test that ran against a shared database left rows. Delete them, or the next test runs against polluted data.
- **Leaked resources.** Connections that didn't close, threads that didn't terminate. Verify the system is at idle baseline before next test.
- **Auto-scaled capacity.** If autoscalers spun up during the test, scale them back down — or wait for the cooldown — before declaring "the test is over". Test artifacts in production capacity are expensive.
- **Cache state.** A load test populates the cache; subsequent tests run against a warm cache and look artificially fast. Either cold-start every test deliberately or note the cache warmth in the result.
- **Logs and metrics.** Save the dashboards and the raw traces. The result a week from now is hard to reconstruct from memory; the artifact is the evidence.

## Tooling notes

The major tools fall into three categories:

- **HTTP load generators.** k6, Vegeta, hey, wrk, JMeter. Good for REST and HTTP APIs; less so for protocol-specific systems. Most support both closed and open-loop modes; verify which you're running.
- **Protocol-specific.** ghz (gRPC), pgbench (Postgres), redis-benchmark (Redis), kafka-producer-perf-test (Kafka). When the system isn't HTTP, use the protocol-native tool.
- **Distributed cloud-based.** Locust + cluster, Gatling, BlazeMeter, k6 Cloud, Artillery. Required when a single host can't generate enough load. Run from multiple regions if testing geo-distributed systems.

A few cross-cutting tooling rules:

- **The generator itself must be observable.** If the load generator is reporting "1000 rps" but the server only sees 200 rps, the gap is the generator's own throughput limit. Monitor the generator's CPU, memory, and request-completion rate.
- **Single-host generators have a ceiling.** A typical host hits a generator-side ceiling around 5-20k rps depending on connection mode. Beyond that, distribute.
- **Co-locate or document the generator's location.** Running the generator from a different region than the target introduces network latency that contaminates the measurement.

## Interpreting results

After the test, the report-writing discipline matters as much as the test design:

- **Lead with the question.** "We asked: can the system sustain 5x baseline for 4 hours? Result: yes / no / yes-with-caveats." Not "here's a graph".
- **Tabulate the SLA metrics.** Target p99 vs measured p99. Target error rate vs measured error rate. Headroom percentage vs target.
- **Document failure modes observed.** Even if the SLA was met, anything weird that happened (a brief latency spike, a recovered error, a metric that flatlined briefly) is worth noting. The next person reading the report needs the context.
- **Compare to the failure hypothesis.** "We expected the DB to be the bottleneck; actual bottleneck was the cache." That's a learning, not a fail.
- **Attach the raw artifacts.** Dashboards, traces, generator output. The numbers in the report should be reproducible from the raw data.

The report is the durable artifact. A test result in someone's memory is a test result lost. The next capacity question (six months from now) asks "what did we see last time?" — the report answers that.

## Pre-launch vs ongoing

Load testing is not a one-time pre-launch activity. Patterns:

- **Pre-launch.** First load test before the system sees real traffic. Both SLA verification and breakpoint discovery.
- **Pre-event.** Before a high-traffic event (a campaign, a partnership, a holiday). Verify the SLA at the expected event-day load.
- **Post-significant-change.** After a major version upgrade, after a schema migration, after a new dependency lands. Verify the performance envelope hasn't shifted.
- **Periodic baseline.** Quarterly or monthly steady-load run; trend the breakpoint over time. Reveals the slow degradations that no single PR caused but together drifted.

A team that load-tests once at launch and never again is one major dependency upgrade away from a surprise.

## Output format

When this skill is invoked to plan or interpret a load test, structure your output as:

1. **Question being answered** — SLA verification, breakpoint discovery, capacity planning, soak for leaks.
2. **Load shape and rate** — steady / ramp / spike / soak / burst, with concrete numbers.
3. **Traffic model** — single-endpoint / hand-built / captured ratio / replay, with the source.
4. **Failure hypothesis** — what you expect to fail first and why.
5. **Instrumentation checklist** — application, system, dependency, tracing, logs.
6. **Environment** — same as prod or scaled; document the gap.
7. **Pass criteria** — for SLA verification, the specific thresholds; for breakpoint, the degradation definition.
8. **Cleanup plan** — test data, leaked resources, autoscaled capacity, cache state.

## Common anti-patterns

- **The single-endpoint hammer.** All requests are `/health`; the test passes; production still falls over because real traffic is shaped differently.
- **Closed-loop only.** Test runs at 100% saturating throughput, declares "the system handles 1000 rps". Real users have think-time; the actual user capacity may be very different.
- **No think-time, no realistic load curve.** Real users don't burst-fire requests in lockstep; the test that simulates that overestimates capacity.
- **Reading the result without an SLA.** "It got slower" is not a pass/fail; you need a number to measure against.
- **Testing against dev and shipping to prod.** Dev is not prod. The test result transfers only if the environment transfers.
- **No instrumentation.** Test runs, system slows down, nobody can say why. Useless.
- **Skipping write traffic.** GETs only. Production has writes; writes hit different bottlenecks; you've tested half the system.
- **Skipping cleanup.** Test data accumulates, leaks accumulate, the next test runs against a polluted baseline.
- **Calling SLA-met-at-95%-of-breakpoint a pass.** It's a pass with no headroom; any production noise tips it over.
- **No 'what fails first' hypothesis.** Test runs, something fails, the team is surprised. Hypothesis-driven testing produces insight; hypothesis-free testing produces numbers.

## Related skills

- `performance-profiling` — post-launch, when a slowdown is happening, profile to find the bottleneck rather than load-test to find the breakpoint.
- `monitoring-and-alerting` — the alerts that catch production load problems use the same metrics the load test exercises.
- `safe-public-release` — for high-stakes launches, the load test is a release gate, not a one-off check.
- `feature-flagging` — when rolling out behind a flag, load test the new path at the target rollout percentage before ramping further.
- `incident-response` — when a load test reveals an in-production-shaped failure, treat the next page as a known mode you've already characterized.
- `architecture-decision-records` — the load test result is evidence for ADRs about capacity, scaling strategy, and dependency choice.
- `logging-discipline` — the high log volume during load tests is a stress test of the logging pipeline. Capture which log lines flicker or get dropped.
- `oncall-rotation-design` — load test results inform the runbook the on-call uses when production traffic spikes.
- `backup-and-restore` — load testing the recovery path (restore the DB under load, watch it stabilize) is a special-purpose load test worth running.
- `safe-public-release` — pre-release load testing is a release gate for high-stakes launches.
