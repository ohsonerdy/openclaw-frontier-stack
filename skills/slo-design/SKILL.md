---
name: slo-design
description: Use when choosing what to measure as a service-level indicator (SLI), where to set the service-level objective (SLO) target, and how to operate an error budget without it becoming theater. Triggers when the user mentions "set an SLO", "what should our SLI be", "error budget", "availability target", "p99 vs average", "latency SLO", "we have an SLO but ignore it", "burn rate alert", or "should this be 99.9% or 99.99%". The skill covers the difference between availability and quality, percentile latency vs averages, window selection, error-budget policy, and the SLO anti-patterns that make the number meaningless. For the alerting on SLO burn, see monitoring-and-alerting. For incident response when the budget is exhausted, see incident-response.
metadata:
  version: 0.1.0
---

# SLO design

A service-level objective is a promise about the reliability of a service. The promise is only as useful as the measurement behind it. An SLO of "99.9% available" sounds rigorous but is meaningless until you know what counts as "available", over what window, and what happens when the number drops below target.

The discipline of SLO design is to pick the smallest set of indicators that actually reflects user experience, set a target that the team can defend, and define what the team will do when the budget is consumed. An SLO that everyone agrees to but nobody acts on is decoration.

This skill covers the choice of SLI (the metric), the SLO target (the threshold), the window (the period over which it's measured), and the error-budget policy (what happens when the budget is gone). For the alerts that fire when burn accelerates, see monitoring-and-alerting.

## When to invoke this skill

- Setting an SLO for a new service.
- Reviewing an existing SLO that doesn't seem to track user experience.
- Choosing between latency percentiles (p50, p95, p99, p99.9) for the SLI.
- Choosing the rolling window (28 days, 30 days, quarter).
- Writing the error-budget policy: what changes when the budget is exhausted.
- Debating whether the target should be 99.9% or 99.99% (or higher).
- Auditing an SLO library where nobody acts on the numbers.

## Availability vs quality

Two different things often collapsed under one SLO. They have different SLIs and different policies.

- **Availability.** The service responds successfully to a valid request. Failed requests count against the SLO; non-failures don't. Measured as "success rate" or "request success ratio". The SLI is `successful_requests / valid_requests`.
- **Quality.** The service responds correctly and quickly. A request that returns 200 in 30 seconds may be available but is not high-quality. The SLI is typically a latency percentile, a correctness rate, or a freshness measure.

A user who can't reach the service has an availability issue. A user who reaches the service but gets a 30-second response has a quality issue. Both can fail independently. Many teams have an availability SLO and call it done; they're missing the quality side.

The decision rule: if the service has a tight latency expectation (interactive UI, payment path, search), a quality SLO is needed alongside availability. If the service is fire-and-forget (background job, async pipeline), availability and a freshness SLO are usually enough.

## Choosing the SLI

The SLI is the metric that defines the SLO. Get this wrong and the SLO target is meaningless.

Three rules for picking a good SLI:

- **User-experience-proxied.** The SLI should track what the user experiences, not what the system measures internally. The user doesn't care about CPU utilization; they care about whether their request succeeded. CPU utilization is operational; it's not an SLI.
- **Numerator over denominator.** The SLI is a ratio: good events over total events. "Successful requests over total valid requests" is a ratio. "Number of 5xx responses" is a count and not directly an SLI.
- **Excludes invalid input.** The denominator counts requests the service was supposed to succeed on. A 4xx caused by malformed client input does not count against the service. A 5xx caused by the service does. Define the "valid request" boundary clearly.

Common SLIs:

- **Request success ratio.** `(2xx + 3xx + intentional 4xx) / (all valid requests)`. The classic availability SLI.
- **Latency percentile under threshold.** `(requests under threshold) / (all valid requests)`. E.g., "95% of requests complete under 300ms".
- **Freshness.** `(records updated within threshold) / (all records)`. For async pipelines.
- **Correctness.** `(requests with correct response) / (all requests)`. Needs a correctness oracle, often hard.
- **Coverage.** `(successful syncs) / (expected syncs)`. For batch workloads.

Anti-pattern: choosing the SLI based on what's easy to measure. The metric your monitoring already collects may not match the user experience. The SLI design comes first, then you build the measurement.

## Percentiles vs averages

For latency SLIs, the choice of percentile matters more than the threshold.

- **Averages lie.** A mean latency of 200ms can hide a long tail where 1% of users wait 30 seconds. The average does not capture the experience of the worst-affected users.
- **p50 (median).** What the typical user sees. Good for "is the service generally fast?" Not useful for catching tail latency.
- **p95.** The slowest 5% of requests. Catches early tail latency. Common SLI target.
- **p99.** The slowest 1%. Catches more of the tail. The standard latency SLI for user-facing services.
- **p99.9 and beyond.** The slowest 0.1%. Becomes operationally hard to measure stably; noisy when traffic is low. Useful for very high-volume services.

The choice of percentile depends on the service's tail-sensitivity:

- **Interactive UI, payment, search.** p99 latency SLO. The slowest 1% of users matter; one bad request can break a checkout flow.
- **Internal API consumed by other services.** p99 or p99.9, because downstream services experience the tail.
- **Batch or background.** Often p95 is sufficient; tail latency is less user-visible.

Anti-pattern: setting a latency SLO on average latency. The average can be in spec while the tail is broken. Always pick a percentile.

## The target number

The SLO target ("99.9%") is a choice with operational consequences. Higher is not better in general; higher targets demand more engineering investment.

A useful framing: the SLO target sets the error budget, which is the amount of failure the team is willing to tolerate before changing behavior.

- **99% (two nines).** ~7.2 hours of failure per month, or ~3.65 days per year. Suitable for non-critical or early-stage services.
- **99.5%.** ~3.6 hours per month, or ~1.83 days per year. Common for non-revenue-critical user-facing services.
- **99.9% (three nines).** ~43 minutes per month, or ~8.76 hours per year. Common target for production user-facing services.
- **99.95%.** ~21 minutes per month, or ~4.38 hours per year.
- **99.99% (four nines).** ~4.3 minutes per month, or ~52 minutes per year. Requires significant engineering investment: redundant infrastructure, fast failover, automated mitigation. Rare for services that aren't critical infrastructure.
- **99.999% (five nines).** ~26 seconds per month, or ~5.26 minutes per year. Telco-grade. Almost never the right choice for application services.

The decision rule: start with the lowest target that meets the business need. Increase only when there's a demonstrated business cost to the current target and a willingness to invest in the engineering work to meet a higher one. Setting "99.99%" because it sounds good and then missing it every month teaches the team to ignore the SLO.

Anti-pattern: setting the SLO target as an aspiration ("we'd like to be 99.99%") rather than a commitment ("we will operate at 99.9% and the budget pays for everything below that"). Aspirational SLOs get ignored.

## Window selection

The SLO is measured over a window. The window choice changes the policy.

- **Rolling 28 days.** The most common window. Smooths out short outages over a calendar period. Aligns with typical sprint or month cycle.
- **Rolling 7 days.** Catches recent regressions faster, but small outages dominate the window and create noise.
- **Calendar month or quarter.** Resets on a date. Easier to explain in business terms. Discontinuous behavior at the boundary: a four-hour outage on the last day of the month consumes a different budget than the same outage on the first day of the next month.
- **Multi-window.** Combine a long window for the SLO target with a short window for burn-rate alerts. The long window determines whether you're meeting the objective; the short window catches accelerating failure.

The recommendation: 28-day rolling for the SLO itself, with a short-window burn-rate alert (e.g., 1-hour window) for accelerating consumption. The 28-day number is what the team commits to; the short-window alert is what wakes the on-call.

## Error budget

The error budget is the amount of failure permitted by the SLO. A 99.9% SLO over a 28-day window gives a budget of about 0.1% of requests, or about 40 minutes of complete outage.

The budget has two roles:

- **It quantifies the cost of incidents.** A 20-minute outage consumes half the monthly budget. The team can talk concretely about how much budget remains.
- **It gates risky activity.** When budget is fresh, the team can ship riskier changes (assuming the risk doesn't exceed the budget). When budget is exhausted, the team stops shipping until the budget recovers.

The error-budget policy is the rule for what changes when budget is consumed. Without a policy, the budget is just a metric.

A workable policy:

- **Budget healthy (>50% remaining).** Normal operation. Ship changes as usual.
- **Budget tight (10-50% remaining).** Heightened review on changes that could consume more budget. Tier 2 and 3 changes require explicit approval and tested rollback.
- **Budget exhausted (less than 10% remaining or already negative).** Feature work pauses. The team focuses on reliability work until the budget recovers. Only fixes, reliability investments, and tier 4 emergency changes ship.

Anti-pattern: setting a budget and never acting on it. The budget is a coordination mechanism; if the team always ships regardless of budget, the SLO is theater.

## Burn rate

The burn rate is how fast the budget is being consumed. A 1.0 burn rate means budget is being consumed at the SLO's allowed rate (a perfect-100% SLO would burn at zero; a 99.9% SLO burns at 1.0 when 0.1% of requests are failing). A 10x burn rate means budget is being consumed ten times faster than allowed; left unchecked, the monthly budget is gone in three days.

Burn-rate alerts are tuned to specific paces:

- **Fast burn (10x or higher over a short window like 1 hour).** Pages the on-call. The current incident, if it continues, exhausts the budget quickly.
- **Slow burn (2x to 10x over a longer window like 6 hours).** Ticket-grade, not page-grade. There's a trend; the team should look at it but it's not on-fire.

The burn-rate alert is what makes the SLO operational. Without it, the team sees the budget consumed after the fact and can't intervene.

## Multi-window multi-burn alerts

The pair of windows protects against two failure modes:

- A short, sharp incident (fast burn over a short window) — paged immediately.
- A slow, sustained degradation (slow burn over a long window) — caught before the budget exhausts entirely.

A common pattern: alert if fast-burn (1-hour window, 14x burn rate) AND short-confirm-window (5-minute window, 14x burn rate) are both elevated. The short window confirms the burn is happening now; the longer window confirms it's not a single-minute blip.

## Common anti-patterns

- **SLO on a non-user-experience metric.** CPU utilization, queue depth, internal metrics. The user doesn't care.
- **SLO on average latency.** The average hides the tail. Always pick a percentile.
- **SLO target that no one believes (99.999%).** The team can't meet it, ignores it, and the SLO is decorative.
- **No error-budget policy.** The budget is consumed, nothing changes, the SLO doesn't drive behavior.
- **No burn-rate alert.** The team sees the budget exhausted after the fact, can't intervene.
- **Single very-long window (quarterly).** Slow to react; a single bad week is masked.
- **SLO with no defined "valid request".** 4xx malformed requests count against the service, making the SLI noise.
- **Multiple competing SLOs that contradict each other.** Pick one or two indicators; more than three is rarely useful.
- **SLO set by management, not by engineers.** The team can't operate it because they didn't define it.
- **Budget exhausted, team ships anyway.** The policy says pause feature work; the team overrides; the SLO loses meaning.

## Output format

When this skill is invoked to design or audit an SLO, structure the output as:

1. **SLI choice** — the metric, the numerator, the denominator, the boundary of "valid request".
2. **Percentile (if latency)** — p50, p95, p99, with rationale.
3. **Target** — the percentage and what it implies in budget (minutes per month).
4. **Window** — rolling 28 days as default, with rationale for any deviation.
5. **Error-budget policy** — what changes at healthy / tight / exhausted budget.
6. **Burn-rate alerts** — fast-burn and slow-burn windows and thresholds.
7. **Ownership and review** — who owns the SLO and how often it's revisited.

## Related skills

- `monitoring-and-alerting` — the alert rules that translate burn rate into pages.
- `incident-response` — the playbook when the budget is being consumed in real time.
- `post-mortem-writing` — incidents that consumed the budget get a post-mortem that may suggest SLO changes.
- `capacity-planning` — capacity headroom is one input to whether the SLO is achievable.
- `observability-pillars-integration` — the metrics, logs, and traces that feed the SLI calculation.
- `change-management-policy` — the change-tier policy can gate on remaining budget.
