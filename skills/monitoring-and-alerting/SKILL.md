---
name: monitoring-and-alerting
description: Use when designing monitoring for a new service or fixing noisy/missing alerts on an existing one. Triggers when the user mentions "what should I monitor", "alert design", "set up monitoring", "noisy alerts", "alert fatigue", "SLO", "SLI", "dashboard", "page only when actionable", or "why is this alert firing again". The output is a layered observability design: metrics, alerts on user impact, dashboards by audience, runbooks. For the incident that an alert triggers, see incident-response. For the performance problem an alert reveals, see performance-profiling.
metadata:
  version: 0.1.0
---

# Monitoring and alerting

A monitoring system has two products: alerts that page humans, and dashboards that humans read. Both have to be designed deliberately. Alerts that fire on the wrong thing burn out the on-call rotation. Dashboards that show too much aren't read at all. Done well, monitoring is the system telling you what's wrong before users tell you; done poorly, it's noise that obscures the actual signals.

The skill is to think in user impact first, then work backwards to the metrics that predict user impact, then design alerts that fire only when action is required.

## When to use this skill

- Designing observability for a new service before launch.
- Auditing an existing service whose alerts are noisy, missing, or both.
- Defining SLOs / SLIs / SLAs for a service.
- After an incident, when the post-mortem action item is "improve detection".
- After alert fatigue complaints from the on-call rotation.

The signal that you need this skill: the on-call rotation reports alerts that don't correspond to user impact, or post-mortems that say "we detected the issue 15 minutes after users started reporting it".

## Step 1: user-impact metrics first

The first metric is not CPU usage. It's: are users getting what they came for, and at what speed?

For request-oriented services (most APIs, web apps), the RED metrics framework:

- **Rate.** Requests per second. The denominator for everything else.
- **Errors.** Failed requests per second, or the error ratio (errors / total).
- **Duration.** Latency, usually as a histogram — p50, p95, p99.

These three are the user-impact signal. If errors are zero and duration is normal, users are happy regardless of what CPU is doing. If errors are climbing, users are not happy regardless of what CPU is doing.

For resource-oriented services (databases, caches, queues), the USE metrics framework:

- **Utilization.** What percentage of the resource's capacity is in use.
- **Saturation.** Queue depth, wait time, anything indicating the resource has more work than it can do.
- **Errors.** Operations that failed.

These two frameworks complement: RED at the application surface, USE at the infrastructure layer below.

## Step 2: four golden signals

Google's SRE book popularized four signals that overlap RED and add one more:

- **Latency.** Same as Duration. Distinguish successful-request latency from failed-request latency; failures often have different timing.
- **Traffic.** Same as Rate.
- **Errors.** Same.
- **Saturation.** How full the system is. The fourth signal — RED doesn't include this for request-oriented services, but it matters because saturation predicts latency and error increases before they happen.

Use whichever vocabulary your team likes. The point is to cover all four; what you call them matters less.

## Step 3: SLI, SLO, SLA

The vocabulary matters here because the terms get confused.

- **SLI (Service Level Indicator).** A specific measurement of service quality. "Fraction of requests returning 2xx within 200ms over a 5-minute window."
- **SLO (Service Level Objective).** A target for the SLI. "99.9% of requests must return 2xx within 200ms over a rolling 30-day window."
- **SLA (Service Level Agreement).** A contractual commitment to an SLO, usually with consequences for missing it. "If SLO falls below 99.5%, customer is entitled to a 25% credit."

The chain matters:

- SLIs are picked from the user-impact metrics — what does success look like, what does failure look like, what's "fast enough".
- SLOs are targets for the SLIs — set them slightly tighter than what you think users will tolerate. The gap between SLO and user tolerance is the error budget.
- SLAs are commitments only made when SLOs are validated.

Common mistakes:
- SLIs that measure internal state rather than user impact ("CPU usage stays below 80%" is not an SLI).
- SLOs set without measurement (number invented in a meeting, not derived from user feedback or historical data).
- SLOs set at 100%. 100% is not achievable and not worth pursuing. Pick a number that leaves headroom for change.

## Step 4: alert on symptoms, not causes

The single biggest alert-quality lever is whether the alert fires on a user-affecting symptom or on an internal cause.

- **Symptom alerts.** "p99 latency exceeded 500ms for 5 minutes." "Error rate exceeded 1% for 2 minutes." "Login success rate dropped below 99%." Fire when users are affected.
- **Cause alerts.** "Database connection pool is 80% full." "Memory usage is over 90%." "Disk is 85% full."

Symptom alerts are the right default for paging. They fire when the system is failing users; the on-call responds because users are affected.

Cause alerts are useful for early warning but should not page. They fire when something is heading toward problems but hasn't manifested yet. They go into dashboards and lower-severity channels (Slack, email), not pages. The exception is causes that are so close to symptoms that the warning is itself the alert (disk full = imminent failure).

If your pager is full of cause-alerts, the on-call wakes up for things that aren't yet affecting users — and learns to ignore the pager. By the time real symptoms appear, the trust is gone.

## Step 5: alert design checklist

For each alert, before adding it:

1. **What user impact does this detect?** State the symptom in user-facing terms. If you can't, the alert is probably a cause-alert.
2. **Is this actionable?** When this fires, is there a specific thing the responder does? "Investigate" is not an action; "rollback the recent deploy" or "scale up the workers" is.
3. **What's the threshold?** Why this number? Derived from baseline + acceptable deviation, not invented.
4. **What's the time window?** Brief spikes that self-recover shouldn't page. 5-minute windows are common; some metrics warrant longer to reduce noise.
5. **Who gets paged?** The team that owns the service, not "everyone". Routing is part of the alert.
6. **What's the runbook?** Every alert links to a runbook. If there's no runbook, write one or don't add the alert.
7. **What's the escalation path?** If the on-call doesn't respond in N minutes, who's next?
8. **How will this alert fail?** False positives during deploys, scheduled maintenance, dependency outages. Plan for them.

An alert that doesn't pass all of these is not ready. Adding it anyway is adding noise.

## Step 6: alert fatigue triage

Existing alerts that fire too often:

- **Kill it.** If the alert hasn't been actionable in months, delete it. It's not earning its keep.
- **Tune it.** If the alert is sometimes actionable but mostly noise, adjust the threshold, time window, or both. Often a too-low threshold or too-short window.
- **Route it.** If the alert is informative but not pageable, send it somewhere humans look but aren't paged from — Slack channel, daily digest, dashboard.
- **Add hysteresis.** If the alert flaps (fires, resolves, fires, resolves), require the condition to hold longer before firing and longer before resolving.

The audit:

1. List all alerts that fired in the last 30 days.
2. For each, count the firings.
3. For each, count the actions taken (rollback, intervention, real fix).
4. Action rate = actions / firings. Below 30% is fatigue territory. Below 10% is "this alert is noise".

The cost of keeping a noisy alert is the on-call ignoring all alerts. The action of pruning is itself a critical maintenance task.

## Step 7: dashboard hierarchy

Multiple dashboards, layered:

- **Overview dashboard.** One per team or per product area. Shows the four golden signals across the whole surface. The "are we healthy" dashboard. Read at start of shift, glanced at during the day.
- **Service dashboard.** One per service. The four golden signals for that service, plus key business metrics, plus saturation indicators. Read when an alert fires on that service.
- **Component dashboard.** One per significant subsystem within a service. Detailed breakdowns of what's happening inside. Read during investigation.
- **Host / instance dashboard.** Per-machine view. Read rarely; mostly for finding bad replicas.

The hierarchy is a drill-down. The on-call starts at overview, navigates to service, then to component, then to host, only as needed. Each level shows what's needed at that level and links to the next.

Common mistakes:
- One dashboard with everything. Unreadable.
- Each engineer's personal dashboard. Doesn't survive engineer turnover.
- Dashboards built for the demo and never used. Should be ruthlessly pruned.
- Dashboards with charts of metrics nobody understands. Either explain or remove.

## Step 8: the "what would I want to see at 2am" filter

Every alert is a 2am page in waiting. The filter to apply to alert and dashboard design:

When you're paged at 2am, what do you need in the first 60 seconds?

- The alert itself, saying what failed in user-impact terms.
- A link to the runbook for this specific alert.
- A link to a dashboard showing the symptom over time, with annotations for recent deploys and changes.
- Recent change context: what shipped, when, who was on-call.

What you don't need at 2am:
- A wall of metrics with no priority order.
- Cause-alerts that don't tell you what users see.
- Vague threshold violations like "metric X went above Y" with no context for whether Y is the right threshold.

Design the alert and the dashboard for the worst case — sleep-deprived responder, narrow attention, high anxiety. Every extra step they have to take to figure out what's wrong is a step where they make a mistake.

## Step 9: runbook discipline

Every alert links to a runbook. The runbook has:

- **What this alert means.** In user-facing terms.
- **What to check first.** The first action the responder takes — usually "look at the symptom dashboard linked here".
- **Common causes.** What this alert usually means in practice. List the top 3–5.
- **Mitigation options.** Specific actions for the responder, with decision criteria.
- **When to escalate.** Conditions under which the on-call pages someone else.

The runbook is a living document. After every incident, update the runbook for any alert that fired:

- If the alert helped, document why.
- If the cause was something the runbook missed, add it.
- If the runbook's first action was wrong, fix it.

An alert without a runbook is an alert that wastes the responder's time. A runbook that's never updated is a runbook that loses trust.

## Step 10: monitoring as a deliverable

Monitoring is not a side-project. Treat it as a deliverable with the same rigor as features:

- **Designed before launch.** A new service ships with its alerts, dashboards, and runbooks in place. Not "we'll add monitoring later".
- **Reviewed.** Alert definitions go through code review. Runbooks go through review.
- **Tested.** New alerts run in a non-paging mode (Slack, log) for a calibration window before they page. Confirms thresholds are right.
- **Owned.** The team that owns the service owns the alerts on it. Hand-me-down alerts from a previous team without ownership decay fast.

The team that ships monitoring as a feature has dramatically fewer 2am pages than the team that bolts it on. The investment pays back in nights of uninterrupted sleep.

## Common anti-patterns

- **Alerts on causes, not symptoms.** Disk-full, CPU-high, memory-pressure alerts paging the on-call. Tune to symptoms.
- **No runbooks.** Every alert without a runbook is a failed alert.
- **Threshold invented in a meeting.** Should come from baseline data + acceptable deviation.
- **Static thresholds on metrics that scale.** As traffic grows, an absolute-error-count threshold becomes meaningless. Use ratios.
- **Single dashboard for everything.** Hierarchy or it's unreadable.
- **Charts of metrics nobody understands.** Remove or explain.
- **Alerts that flap.** Add hysteresis or longer windows.
- **Page-on-everything during deploys.** Suppress non-critical alerts during deploy windows; otherwise every deploy is a noise storm.
- **No alert-quality audit.** Action rate below 30% is fatigue. Audit quarterly.
- **Adding alerts without removing.** Alerts accumulate; the team that only adds eventually has a wall of noise. Prune aggressively.

## Output format

When this skill is invoked, produce:

1. **Service profile** — what the service does, who calls it, what user impact looks like.
2. **SLIs** — the user-facing measurements that define success.
3. **SLOs** — targets for the SLIs, with rationale.
4. **Alert design** — one entry per alert: what fires, threshold, window, audience, runbook link, escalation.
5. **Dashboard plan** — overview / service / component dashboards, with the charts and audience for each.
6. **Cause-alert lower-severity channel** — what goes to Slack/email instead of paging.
7. **Audit plan** — when to review action rates and prune.

## Related skills

- `incident-response` — what happens when an alert fires. Alerts and runbooks should produce smooth incident response.
- `performance-profiling` — when an alert reveals a performance regression, the deeper investigation.
- `post-mortem-writing` — many post-mortem action items land here. New detection signals, retuned thresholds, missing runbooks.
- `threat-modeling` — the detect-bucket mitigations from threat modeling become monitoring designs.
