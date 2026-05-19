---
name: capacity-planning
description: Use when sizing a service for the next quarter of demand growth, deciding how much headroom to hold, deciding whether to scale before or during traffic, or recovering from an incident where the service ran out of capacity in production. Triggers when the user mentions "capacity planning", "how many replicas", "what size machine", "headroom", "scaling headroom", "size for peak", "burst capacity", "sustained capacity", "Black Friday sizing", "we ran out of capacity", "the load test didn't predict this", or "the autoscaler couldn't catch up". The skill covers demand forecasting, the difference between burst and sustained capacity, headroom rules under uncertainty, load-test inputs that match production, and the failure modes when capacity planning is treated as a one-time exercise. For the load-testing mechanics, see load-testing. For the alerts that detect capacity exhaustion, see monitoring-and-alerting. For the SLO impact of capacity shortfalls, see slo-design.
metadata:
  version: 0.1.0
---

# Capacity planning

Capacity planning is the work of having enough resources to serve demand at the moment demand arrives, not at the moment a panic order to scale up gets approved. The discipline is to forecast demand, size for it with deliberate headroom, validate the size with a load test that resembles real production, and rerun the exercise when the demand shape changes.

Done badly, capacity planning collapses into one of two failure modes. The first is the over-provisioned baseline: a service runs at 5% utilization because the team picked a number once during a launch and never revisited. The second is the under-provisioned panic: a service collapses under predictable demand because the team assumed the autoscaler would handle anything. Both are expensive; the second one is also user-visible.

This skill covers the inputs to a credible capacity plan (demand forecast, growth assumptions, traffic shape), the headroom rules that hold up under uncertainty, the difference between burst and sustained capacity, the load-test inputs that make the plan trustworthy, and the cadence of revisiting the plan as the system changes. For the load-testing mechanics themselves, see load-testing. For the alerts that catch capacity exhaustion in flight, see monitoring-and-alerting.

## When to invoke this skill

- Sizing a service before a launch.
- Quarterly review of an existing service's capacity vs forecast demand.
- Preparing for a known traffic event (sale, product launch, marketing push, seasonal peak).
- Post-incident analysis after a capacity-related outage.
- Deciding whether autoscaling alone is sufficient or pre-provisioning is needed.
- Reviewing the cost of an over-provisioned service.
- Choosing the machine size or replica count for a new deployment.
- Auditing whether the load tests in CI actually predict production behavior.

## Demand forecast as the input

A capacity plan starts with a demand forecast. Without one, you're sizing by intuition.

The forecast has three components:

- **Current demand.** The actual rate of requests, jobs, or data the service handles today. Drawn from real metrics over a representative window (typically 4 to 8 weeks to smooth weekly cycles).
- **Growth rate.** The expected increase in demand over the planning horizon. Drawn from business projections (new customer signups, marketing-driven traffic, regional rollouts). Express as a percentage per month or as a multiplier per quarter.
- **Demand shape.** The distribution of demand over time — peak-to-trough ratio, daily cycle, weekly cycle, seasonal effects. Two services with the same average load can have wildly different peak loads.

The decision rule: size for the projected peak demand at the end of the planning horizon, not the current average. A service sized for current average will be under-provisioned within weeks if growth is non-trivial.

Anti-pattern: a capacity plan that uses last week's average as the input without considering growth or peak. The plan is obsolete before it ships.

## Burst vs sustained capacity

Two different capacity questions, often confused. They have different sizing rules.

- **Sustained capacity.** What the service can handle continuously, day after day, without exhausting any resource. Bounded by CPU, memory, network, downstream connection pools, database write throughput. The sustained number is what the average and the multi-hour peak demand should be compared against.
- **Burst capacity.** What the service can handle for short windows (seconds to minutes) before backpressure or queuing degrades the experience. Often higher than sustained because warm caches, headroom in connection pools, and not-yet-saturated downstreams absorb the burst.

The decision rule:

- **For predictable load (steady-state, daily peaks).** Size sustained capacity to the projected peak plus headroom. Burst is irrelevant; you're never in the burst regime.
- **For bursty load (event-driven, viral, traffic spikes).** Size sustained capacity to the steady-state plus headroom; size burst capacity to the expected peak burst plus headroom. The two numbers are different.
- **For autoscaled services.** Sustained capacity is the post-scale-out number; burst capacity is the pre-scale-out number. Autoscaling takes minutes to add capacity; whatever burst hits in those minutes lands on the unscaled fleet.

Anti-pattern: assuming autoscaling absorbs all bursts. Autoscaler reaction time is in the minutes; bursts can be in the seconds. The fleet has to survive the burst until the autoscaler catches up.

## Headroom rules

Headroom is the gap between projected peak utilization and 100%. The size of the gap protects against forecast error, traffic anomalies, dependency degradation, and the autoscaler's reaction time.

Workable defaults, adjusted by service criticality and demand variability:

- **Predictable steady-state service, mature autoscaler.** Run at 60-70% peak utilization. Headroom of 30-40% absorbs short anomalies; autoscaler handles the rest.
- **Variable demand, autoscaling effective.** Run at 50-60% peak utilization. The extra headroom protects against the autoscaler's lag.
- **Variable demand, no autoscaling.** Run at 40-50% peak utilization. The whole headroom has to absorb the variance.
- **Critical user-facing service with high blast radius.** Add an extra 10-15 percentage points of headroom; the cost of a capacity-driven outage exceeds the cost of the spare capacity.
- **Backend or asynchronous work that can queue.** Lower headroom is acceptable if the queue absorbs short overflows and SLAs are defined around queue depth rather than instantaneous capacity.

The decision rule: pick a headroom percentage, document why, and revisit when demand shape or autoscaler behavior changes. A service running at 90% utilization has no margin for anomalies; one minute of unexpected demand is an incident.

Anti-pattern: running at 90% utilization to "save money" without quantifying the cost of the outages that result. The savings are real; the outages erase them.

## Load test inputs that match production

A load test is only as good as the inputs match real production traffic. The common failure: the load test fires a uniform stream of one request type at average rate; production fires a varied mix at peak rate with realistic timing.

Inputs the load test needs to resemble production:

- **Request mix.** The proportion of each endpoint or request type. A load test that hits one endpoint doesn't predict behavior when ten endpoints are mixed.
- **Request payloads.** Sizes and shapes that match real traffic. Tiny test payloads don't exercise the same serialization, validation, or downstream behavior as real ones.
- **Rate profile.** Ramp up and down at real-traffic-pace. A step-function 10x ramp is not realistic; a slow ramp with a spike is.
- **Concurrency model.** Real users with think time, not max-rate firehose. A million synthetic users with zero think time stress a different bottleneck than a million real users.
- **Stateful interactions.** Sessions, auth, caching effects. A load test that bypasses auth or operates with one user ID hits a different code path.
- **Downstream behavior.** If the service depends on a database or cache, the load test should exercise the real interaction, not a stub. Stubs hide the bottleneck.

The decision rule: the load test predicts production only if the inputs match production. Each deviation is a known source of error in the prediction.

Anti-pattern: running a load test once at uniform rate, calling it sufficient, and discovering during the real traffic event that the bottleneck is somewhere the test never exercised.

## Sizing the underlying resource

A capacity plan needs to land on a concrete answer: how many replicas, what size machine, what database tier, what queue limit. The translation from "we expect 10,000 RPS at peak" to "we need 30 m5.xlarge instances" depends on per-replica capacity.

Per-replica capacity is determined empirically:

- **Single-replica load test.** Run a load test against one replica until it saturates. The saturation point determines per-replica capacity.
- **Scaling test.** Run the same test against 2, 4, 8 replicas. Confirm linear scaling. Non-linear scaling means there's a shared bottleneck (database, cache, external service) that capacity planning has to address upstream.
- **Saturation curve.** Identify the per-replica RPS at which latency degrades unacceptably. That number is the per-replica capacity; multiply by replica count to get total capacity.

The fleet size is then projected_peak_demand × (1 + headroom) / per_replica_capacity, rounded up.

Anti-pattern: deriving per-replica capacity from production utilization. The current utilization tells you what the fleet does at current demand, not what one replica can do. The per-replica number requires its own measurement.

## Autoscaling: complement, not substitute

Autoscaling is a useful tool, not a replacement for capacity planning. Three things autoscaling doesn't do:

- **It doesn't react fast enough for sudden bursts.** A typical autoscaler reaction time is 2 to 10 minutes (metrics window + scale-out decision + boot time). A traffic burst that arrives in seconds lands on the unscaled fleet.
- **It can't scale past the upstream limits.** If the database connection pool is exhausted, adding replicas doesn't help; new replicas can't connect.
- **It can't size what it can't see.** A scheduled job that runs once a day at 1am may not trigger autoscale-out before it finishes; the autoscaler scales in time for a similar load the next day, not for the current one.

The healthy pattern: pre-provision enough capacity to absorb expected peak plus headroom; let autoscaling handle the next layer of unexpected variance. The autoscaler is the safety net, not the plan.

Anti-pattern: setting the baseline replica count at one and trusting autoscaling for everything. The first real burst is an outage because no autoscaler is that fast.

## Pre-provisioning for known events

For known traffic events (a product launch, a sale, a marketing push), pre-provision before the event rather than relying on autoscaling.

The pre-provision checklist:

- **Forecast the event's peak.** Use historical data from similar past events, marketing's reach projections, and a conservatism factor.
- **Pre-scale the service.** Set replica count or fleet size to the forecasted peak plus headroom, well before the event window starts.
- **Pre-scale the downstreams.** Database connections, cache size, external service quotas — anything that's a per-fleet ratio needs to scale with the fleet.
- **Pre-warm.** Caches, connection pools, JIT-compiled code paths. A cold fleet at the moment of peak is a fleet that under-performs its capacity.
- **Run a load test at the pre-scaled size.** Confirm the new size actually handles the forecasted peak; don't trust the math without verification.
- **Define abort criteria.** If the event traffic exceeds the forecast, what's the response — emergency scale-out, traffic shedding, feature flags to reduce work per request.

Anti-pattern: hoping autoscaling handles a known event. Known events are the place to use deliberate pre-provisioning; that's exactly the case where the forecast is real and the cost of caution is paid in over-provisioning, not outage.

## Cadence and re-planning

A capacity plan is good for a window. Demand shape changes; the plan needs to be refreshed.

A workable cadence:

- **Quarterly review.** For most services, the plan is revisited each quarter against actual demand and updated growth projections.
- **Pre-event review.** Before a known traffic event, the plan is updated specifically for that event.
- **Post-incident review.** After a capacity-related incident, the plan is reviewed and either the headroom is raised or the forecast is corrected.
- **Major change review.** When the service's request shape changes (new endpoint, new feature, new downstream), the plan is re-derived; the old per-replica capacity may no longer hold.

The decision rule: the plan has an expiration date. Treat it as fresh until the date or until a triggering event, then re-derive.

Anti-pattern: capacity-planned once at launch, never revisited, growth has tripled traffic and nobody noticed.

## Common anti-patterns

- **Sizing from current average.** Misses peak and growth; under-provisioned within weeks.
- **No headroom.** Running at 90% utilization; any anomaly is an outage.
- **Autoscaling as the entire plan.** Reaction time too slow for bursts; upstream limits not addressed.
- **Uniform load test.** Tests average rate of one endpoint; misses the real production shape.
- **Per-replica capacity guessed.** Not measured; fleet size is wrong by an unknown factor.
- **Pre-provisioning skipped for a known event.** Autoscaling can't catch the burst; the event peak is an outage.
- **Caches and connections not scaled with the fleet.** Adding replicas exhausts the database connection pool.
- **No downstream coordination.** Service scales; the database it depends on doesn't.
- **Plan revisited never.** Demand shape changes; the plan is obsolete.
- **Headroom set as a slogan ("run lean").** Specific number not chosen, not documented, not defended.

## Output format

When this skill is invoked to write or audit a capacity plan, structure the output as:

1. **Demand forecast.** Current demand, growth rate, demand shape (peak-to-trough), horizon.
2. **Burst vs sustained.** Separate numbers for each, with the rationale.
3. **Headroom choice.** Percentage, with reasoning grounded in autoscaler behavior and service criticality.
4. **Per-replica capacity.** Measured value with the load-test setup that produced it.
5. **Fleet sizing math.** Projected peak × (1 + headroom) ÷ per-replica capacity, with the resulting replica count.
6. **Upstream scaling.** Database, cache, connection pools, external quotas that need to scale with the fleet.
7. **Load-test plan.** Request mix, payload shape, ramp profile, concurrency model.
8. **Pre-event procedure if applicable.** Pre-scale, pre-warm, abort criteria.
9. **Review cadence.** When the plan is revisited.

## Related skills

- `load-testing` — the mechanics of constructing the load test; this skill covers the inputs and the interpretation.
- `monitoring-and-alerting` — capacity exhaustion needs an alert before it becomes user-visible.
- `slo-design` — the SLO defines the latency or success-rate that capacity needs to support.
- `incident-response` — a capacity-driven outage is an incident; the playbook applies.
- `safe-public-release` — a release that changes per-request work invalidates the per-replica capacity number.
- `query-performance-tuning` — a per-request inefficiency multiplied by traffic is a capacity problem; tuning a single query can avoid a fleet scale-out.
- `disaster-recovery-exercise-design` — DR scenarios often include capacity loss (zone failure, region failure); capacity plans assume a worst-case.
- `observability-pillars-integration` — the metrics that drive capacity decisions need cardinality discipline and per-service granularity.
