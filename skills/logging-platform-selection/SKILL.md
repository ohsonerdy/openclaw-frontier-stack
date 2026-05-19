---
name: logging-platform-selection
description: Use when picking a logging platform — self-hosted ELK, Datadog, Splunk, Loki, OpenSearch, CloudWatch — or migrating between them. Triggers when the user mentions "logging platform", "log aggregation", "Datadog vs Splunk", "self-hosted logging", "log retention costs", "log forwarding", "ELK", "Loki", "CloudWatch logs", or "our logs are too expensive". The skill covers the four-axis decision matrix (cost, latency, retention, query power), the volume-band selector, self-hosted vs managed tradeoffs, the daily-query identification, retention by log type, and incident-response speed as the headline benchmark. For the upstream question of what to log and how, see logging-discipline. For the alerts that consume the logs, see monitoring-and-alerting.
metadata:
  version: 0.1.0
---

# Logging platform selection

The logging platform is a long-term commitment. Once your logs are in it, your dashboards reference it, your alerts query it, your engineers know its query language, and moving to a different one is months of work. The selection decision compounds.

Most teams pick a logging platform once, regret it slowly, and then keep paying because migration is expensive. The discipline here is to make the choice well the first time by stating the constraints, not by picking based on marketing pages.

This skill is the platform selection itself. The upstream question of what to log and at what level is in logging-discipline; the downstream question of what alerts to build on top of the logs is in monitoring-and-alerting. The platform sits between them.

## When to invoke this skill

- Picking a logging platform for a new project or organization.
- Auditing an existing platform against your current needs (volume, queries, cost).
- Considering migration between platforms.
- Reviewing the cost of your current logging spend and finding it surprising.
- Designing a multi-platform architecture (e.g., hot recent logs in one system, archived logs in cheaper storage).
- Setting retention policies and wondering whether the platform supports tiered retention.

## The four-axis decision matrix

The platform is a choice along four dimensions. The right answer depends on which axes matter most for your situation.

- **Cost.** Per-GB ingested, per-GB stored, per-query, per-user. Different platforms price differently; total cost varies dramatically with your access pattern.
- **Latency.** From log emission to log queryable. Some platforms are sub-second; some take minutes; archival storage takes hours.
- **Retention.** How long the logs are available, at what cost, and at what query latency for old data.
- **Query power.** Full-text search, structured queries, joins across logs, aggregations, regex, language ergonomics. Some platforms are minimal; others are full DSLs.

The decision is which axes are load-bearing for you. Cost matters most if your volume is high and your budget is tight. Latency matters most for incident response. Retention matters most for compliance. Query power matters most for engineers who actually use the logs daily.

No platform dominates all four. Datadog has excellent query power but is expensive at scale. CloudWatch is cheap to ingest but limited in query power. Loki is cheap and good for grep-style queries but weak for analytical work. ELK / OpenSearch are powerful but operationally heavy if self-hosted. State your axes, then pick.

## Volume-band selector

The right platform depends heavily on how much you log. The bands and their typical answers:

- **Under 10 GB/day.** Almost anything works. The constraint is operational simplicity. Default to a managed service (Datadog, Logflare, even CloudWatch with a UI on top). At this volume, the per-GB price is unlikely to be the binding constraint; engineer time is.
- **10-100 GB/day.** The middle band. Managed services start to cost real money but are still tractable. Self-hosted starts to make sense if you have the operational bandwidth. Loki is competitive in this band for grep-style use; ELK / OpenSearch for analytical use.
- **100 GB - 1 TB/day.** The cost crossover band. Datadog's per-GB pricing at this volume is significant; many teams find self-hosting cheaper if they have the engineering capacity. Tiered architectures start to make sense (hot in one platform, cold in cheaper storage).
- **Above 1 TB/day.** Most managed services become expensive. The default is self-hosted (ELK / OpenSearch / ClickHouse) with potentially a Datadog-or-similar facade for the most-queried subset. At this volume, even the storage cost matters; tiered retention is mandatory.

The volume band is the first filter. Within the band, the four-axis matrix narrows further.

## Self-hosted vs managed

The tradeoff:

- **Managed (Datadog, Splunk Cloud, Logflare, etc.).** You pay per-GB and per-query. The vendor handles operational concerns (storage, indexing, scaling, upgrades). The bill grows with your volume; you have less control over the architecture.
- **Self-hosted (ELK / OpenSearch on your infra, Loki, Grafana, ClickHouse).** You pay for compute and storage. You handle operational concerns (storage planning, index management, version upgrades, cluster scaling). Per-GB marginal cost is low; total cost includes engineer time.

The crossover depends on team capacity. A 5-person engineering team running self-hosted Elasticsearch is paying the operational cost of running a database — that's a real ongoing job. A 50-person team can absorb that cost in exchange for the per-GB savings.

The vendor-lock-in question is real. Once you've built dashboards, alerts, and team mental models on one platform's query language, switching is expensive. Self-hosted gives you the option to move (because the data is yours); managed couples you to the vendor.

The honest framing: self-hosted is cheaper at scale and harder to operate. The "harder to operate" cost is paid in engineer time; the "cheaper at scale" benefit is paid in vendor invoices. Pick the side where the cost falls in a place you can afford.

A specific anti-pattern: self-hosting Elasticsearch with a team that doesn't have a dedicated owner. The cluster runs fine for six months, then degrades, then nobody knows how to fix it, then the team is doing emergency patches at 3am. If you self-host, own it.

## The "what queries do we run daily" identification

The platform's query power has to match the queries you actually need to run. The exercise:

- List the 10 most common queries your team runs against logs.
- List the queries you wish you could run but can't because of the current platform.
- List the queries that incident response runs (these are the highest-leverage; speed matters).

Then evaluate each candidate platform against this list. Can you express these queries? How long do they take? How does the platform compare on your queries (not the platform's benchmark queries)?

The most common selection mistake: picking based on marketing benchmarks that don't reflect your actual usage. The vendor's "10x faster than ELK" claim was on a specific workload that may not match yours. Run your actual queries against the candidate platforms; pick based on observed performance, not promised performance.

A specific failure mode: picking a platform with a beautiful UI for ad-hoc queries, then discovering it's slow for the structured queries your alerts depend on. The UI matters less than the alert performance.

## Retention policy by log type

Not all logs need the same retention. The bands:

- **Security and audit logs.** Typically 7 years for compliance. Stored in cheap archival storage; queried rarely; when queried, slowness is acceptable.
- **Operational logs.** 30-90 days. Used for trend analysis, capacity planning, recent incident investigation. Stored in queryable form.
- **Debug logs.** 7-14 days. Used for active incident response; older debug logs are rarely useful. Stored in the fastest tier.
- **Access logs.** Varies by regulatory regime. Often 90 days to 1 year. May overlap with security logs depending on what's being audited.

The default of "keep everything for 90 days at full query speed" is expensive and rarely justified. The cheaper architecture is tiered: hot tier for recent logs, warm tier for medium-aged, cold tier (object storage like S3) for the long tail. Many platforms support this natively; for others, you build the tiering yourself.

Specific implication: if your platform doesn't support tiered retention, you're paying full-speed cost for logs you query once a year. The cost difference between hot tier and S3 cold storage is often 10-50x. A retention policy that uses both is a meaningful cost win.

## Structured-log compatibility

Your logs have a format. The platform has to accept that format. The friction points:

- **Plain text vs JSON.** Most modern platforms prefer structured (JSON) logs. If you're emitting plain-text logs, parsing happens at the platform side, which is expensive and fragile (regex-based parsing breaks when log formats change).
- **Schema flexibility.** Different applications log different fields. The platform should handle dynamic schemas (or you should normalize at the forwarder).
- **High-cardinality fields.** A field like `request_id` has millions of unique values per day. Some platforms index this efficiently; others (especially time-series-oriented ones like Loki) handle it poorly.
- **Volume per field.** A `stack_trace` field can be kilobytes per log line. Storage and indexing cost scales with the field size.

The principle: your platform should accept your format, not the other way around. If a platform requires you to restructure all your logs to fit its model, the migration cost may exceed the platform's benefit.

For new systems, log structured (JSON) from day one. For existing systems with plain-text logs, the migration is its own project; budget for it before picking a platform that requires structured input.

## Incident-response speed as the headline benchmark

The headline benchmark for any logging platform: how fast can the on-call query during an incident? Two specific measurements:

- **Time to first useful result.** From the moment the on-call types a query to the moment they see relevant log lines. Slow query times during an incident burn minutes that are already scarce.
- **Time to dashboard render.** When the on-call pulls up the operational dashboard, how long until the data is current?

These are the queries that matter most. If a platform's daily-driver experience is fast but incident-response queries are slow (because they hit cold tier, or they aggregate over too much data, or the platform's query optimizer is poor), the platform is failing at its highest-value moment.

The benchmark for selection: take your team's three most common incident-response queries, run them against the candidate platforms on production-scale data, and measure. Treat the slowest acceptable response time as the requirement, not the marketing-quoted average.

## Log forwarding architecture

The platform doesn't receive logs directly; something forwards them. The architecture:

- **App emits.** The application writes a log line. Format: structured (JSON) is the default.
- **Local agent.** A forwarder running on the host (Vector, Fluentd, Fluent Bit, Filebeat) reads the log and ships it to the platform. The forwarder buffers locally if the platform is unreachable.
- **Network transport.** TLS, with authentication. Don't ship logs unencrypted.
- **Platform ingestion.** The platform receives, parses, indexes, stores.

Each layer has failure modes. The forwarder can fall behind, fail, or lose buffered data on disk failure. The network can be slow. The platform can rate-limit ingestion. The chain has to be designed with backpressure and visible failure modes.

A specific failure mode: the application emits faster than the forwarder can ship; the forwarder's local buffer fills; the forwarder drops logs without surfacing the drop. The team discovers the missing logs during incident investigation, weeks later, and the corresponding events are gone. Monitor the forwarder's lag and drop rate; alert on both.

## Cost modeling

The vendor's pricing page is the starting point, not the answer. The actual cost depends on:

- **Ingest volume.** GB/day actually shipped, not raw log volume (some platforms compress on ingest).
- **Index volume.** Some platforms index everything; some let you choose what's indexed.
- **Query volume.** Some platforms charge per query; some include unlimited queries.
- **Storage tier.** Hot, warm, cold; varying cost per GB-month.
- **User seats.** Some platforms charge per engineer with read access; can be a meaningful line item at scale.
- **Long-tail features.** Synthetic monitoring, APM, dashboards — often bundled with logs, often a real percentage of the bill.

Model the cost on your actual projected volume and access pattern. The vendor's quote is for a specific configuration; your real cost depends on the choices you'll make once you're using it.

A specific failure mode: picking based on the ingest price, not modeling the index or query costs, then being surprised by the bill. The all-in cost is the relevant number.

## Common anti-patterns

- **Picking based on the vendor's marketing benchmarks.** Run your own queries; benchmark on your data.
- **Self-hosting without a dedicated owner.** Six months of fine, then degradation, then 3am patches.
- **No retention policy.** Everything kept forever at full query speed. The bill grows linearly with time.
- **No tiered retention.** Paying hot-tier cost for logs queried once a year.
- **Plain-text logs into a platform that wants structured.** Parsing failures, dropped fields, expensive ingest.
- **High-cardinality fields in a platform that doesn't handle them.** Slow queries; growing index size; eventually unworkable.
- **Forwarder buffer drops not monitored.** Logs disappear during incidents; team doesn't know until later.
- **Locked into one platform without exit plan.** Migration is months of work; the vendor knows it.
- **Choosing on UI prettiness, not on alert query performance.** The UI matters less than what the alerts depend on.
- **No incident-response benchmark.** The platform is rated daily-driver fast but slow for the queries the on-call needs.

## Output format

When this skill is invoked to select or audit a logging platform, structure your output as:

1. **Volume band.** Current GB/day, projected growth, retention requirement.
2. **Top axis.** Which of cost / latency / retention / query power is the constraint.
3. **Daily queries.** The 10 most common queries; the 3 incident-response queries.
4. **Candidate platforms.** Two to four that fit the volume band and axis priority.
5. **Comparison on actual queries.** How each candidate performs on the listed queries (not vendor benchmarks).
6. **Cost model.** Per-platform projected cost, including ingest, index, query, storage tiers, seats.
7. **Retention architecture.** Hot / warm / cold tiers; what lives where; query latency per tier.
8. **Forwarder architecture.** Agent choice, buffering, monitoring of lag and drops.

## Related skills

- `logging-discipline` — the upstream question of what to log, at what level, in what shape. The platform is downstream; the discipline determines the volume the platform has to handle.
- `monitoring-and-alerting` — the alerts built on top of the logs. Alert query performance is a platform requirement.
- `incident-response` — incident response runs queries during the most time-sensitive moments; the platform's incident-mode speed is load-bearing.
- `performance-profiling` — when logs are slow, the underlying platform performance becomes a service to investigate.
- `backup-and-restore` — logs themselves often need backup; archival storage and cold tier overlap with backup strategy.
- `postdeploy-verification` — post-deploy queries against logs are one of the verification methods; platform speed determines whether verification is fast or laggy.
