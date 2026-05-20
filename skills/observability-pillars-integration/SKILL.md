---
name: observability-pillars-integration
description: Use when the team has metrics, logs, and traces in production but they don't talk to each other — three siloed pipelines, three teams, three bills, and an oncall responder who still can't follow a request from page to root cause. Triggers when the user mentions "metrics logs traces", "three pillars", "telemetry strategy", "observability stack", "correlation IDs", "trace context propagation", "cardinality explosion", "log volume budget", "we have all the data but can't answer the question", "span attributes vs log fields", or "OpenTelemetry rollout". The skill covers what each pillar is for, the correlation primitives that link them, cardinality discipline, the anti-pattern of building three independent pipelines, and the integration tests that prove the pillars actually compose. For the SLO that the pillars feed into, see slo-design. For the alert rules that fire from the metrics, see monitoring-and-alerting. For runbook content that references all three, see runbook-writing.
metadata:
  version: 0.1.0
---

# Observability pillars integration

Metrics tell you something is wrong. Traces tell you which request, on which service, in which span. Logs tell you exactly what the code was doing at the failing point. Each pillar answers a question the others can't. The teams that operate well have all three connected to each other so that one click in the metric dashboard lands the responder in the right trace, and one click in the trace lands them in the right log line.

The teams that have a hard time are the ones who bought three vendors, configured three pipelines, wired three dashboards, and never wired the pillars to each other. The metrics are in one tool, the logs in another, the traces in a third. When a 3am page fires, the responder hops between tabs trying to reassemble what was a single request into a single picture, by hand, while the incident burns.

This skill covers the integration patterns: what each pillar uniquely answers, the correlation IDs and trace context that tie them, the cardinality and volume budgets that keep the cost reasonable, and the rollout sequence that gets a team from three silos to one coherent system. For the SLO calculation that uses the metrics, see slo-design. For the alert rules that translate burn-rate into pages, see monitoring-and-alerting.

## When to invoke this skill

- Planning a new service's observability and choosing what to emit from each pillar.
- Auditing an existing stack where metrics, logs, and traces exist but don't link to each other.
- Reviewing a budget proposal that adds a fourth tool when the existing three aren't integrated.
- Triaging cardinality issues (metric label explosion, log volume blowout).
- Designing the correlation-ID strategy for a request crossing five services.
- Rolling out OpenTelemetry across a polyglot fleet.
- Investigating why a recent incident took 90 minutes to triage when the data was all present.
- Choosing what goes in a span attribute vs what goes in a log field for the same event.

## What each pillar uniquely answers

The three pillars are not interchangeable. They answer different questions, and a healthy stack uses each for what it's good at.

- **Metrics.** Aggregate, low-cardinality, time-series numbers. Cheap to store, fast to query, predictable cost. Answer "how is the system behaving in aggregate?" — error rates, latency percentiles, throughput, saturation. Drive alerts and SLOs.
- **Traces.** Per-request, structured causality across services. Answer "what happened to this specific request, and which service or span was responsible?" Drive root-cause analysis and latency attribution.
- **Logs.** Per-event, high-cardinality, free-form text or structured fields. Answer "what exactly was the code doing at this moment, and why?" Drive deep debugging once a trace or metric has pointed at the right place.

The decision rule for which pillar gets a new signal:

- **Aggregate question across many requests?** Metric. (Error rate, p99 latency, queue depth.)
- **Per-request question with causality across services?** Trace. (Why was this checkout slow? Which downstream timed out?)
- **What exactly happened at one specific point in the code?** Log. (Stack trace, request body that failed validation, the decision-tree branch taken.)

Anti-pattern: trying to answer aggregate questions from logs (slow, expensive, lossy) or trying to debug a single request from metrics (impossible, the per-request detail is gone). Match the question to the pillar.

## Correlation primitives

The pillars compose only when they share identifiers that link the same event across all three. The minimum correlation set:

- **Trace ID.** A 128-bit ID assigned at the entry point of a request and propagated to every downstream service. Every span and every log line emitted while handling that request carries the trace ID. The trace ID is the lookup key from a log line to the trace and from a metric exemplar to the trace.
- **Span ID.** A 64-bit ID for the specific span within the trace. A log line emitted inside a span should carry the span ID so the log is attributable to that span, not just the request.
- **Service name and version.** Every span, every metric, every log carries a `service.name` and `service.version`. This lets you filter "errors in the new version of the payments service" across all three pillars.
- **Environment and region.** Where the event happened. Filtering by environment (`prod` vs `staging`) and region (`us-east-1` vs `eu-west-1`) is needed in every pillar.

The correlation IDs are not optional. A log line without a trace ID can only be found by guessing; a trace without service name can't be filtered. Make these required at the SDK level so they can't be dropped accidentally.

The decision rule: if a signal doesn't carry trace ID, span ID, service name, and environment, it's not properly correlated and the responder won't be able to pivot from one pillar to another.

## Context propagation

Trace context propagation is the mechanism that carries the trace ID across service boundaries. The W3C `traceparent` header is the standard; most modern SDKs implement it.

The propagation needs to work across:

- **HTTP calls.** `traceparent` header injected on the outbound, extracted on the inbound. The OpenTelemetry HTTP instrumentation does this automatically; the team needs to confirm it's actually enabled.
- **Message queues.** Trace context goes in message metadata or headers (Kafka headers, SQS message attributes, RabbitMQ properties). The producer injects, the consumer extracts. If the queue strips headers, the trace breaks at that boundary.
- **gRPC.** Metadata carries the context. Standard gRPC interceptors handle this.
- **Async work within a service.** If a request spawns a background task (worker thread, queued job), the context needs to be captured and re-attached when the task runs. Without explicit handling, the background work is a new trace and the linkage is lost.

Anti-pattern: propagation works for HTTP but not for the message bus, so the trace ends at the producer and resumes at... nowhere. The downstream consumer has no link back. Test propagation across every transport the architecture uses.

## Span attributes vs log fields

Both spans and logs carry structured fields. The question is which gets what.

- **Span attributes describe the operation.** What was called, what arguments, what outcome at the span level. Example: `http.method=POST`, `http.target=/checkout`, `http.status_code=500`, `db.system=postgres`, `db.statement=SELECT...`. Span attributes are intended to be queried as part of the span lifecycle.
- **Log fields describe a discrete event within the operation.** What specifically happened at this line of code. Example: a debug log inside the checkout handler that records the cart contents, the chosen payment method, the validation result. Log fields are intended to be searched as text or filtered as structured key-value.

A useful boundary:

- **One value per span (the request scope) goes on the span.** `user.id`, `tenant.id`, `request.size_bytes`.
- **Per-line events go in logs.** Each log line is its own event with its own timestamp and message.
- **Don't duplicate.** If `user.id` is on the span, every log line emitted in that span inherits it via the trace context; you don't need to re-attach it to every log.

Anti-pattern: putting per-line events as span attributes (the span attribute list balloons; the trace UI is unreadable). Or putting request-scoped attributes only on logs (you can't filter spans by `tenant.id`, so latency-by-tenant analysis is impossible).

## Cardinality discipline

Metrics labels and log fields cost money and storage proportional to cardinality (the number of distinct combinations). A label with high cardinality breaks the metrics backend; a log field with high cardinality blows the budget.

- **Metric labels: low cardinality only.** Service name, environment, region, HTTP method, status code, route template. Bounded sets of values. Total label combinations per metric should be in the hundreds or low thousands, not millions.
- **Forbidden as metric labels.** `user_id`, `trace_id`, `request_id`, full URL path, customer name, email address. These have unbounded or near-unbounded cardinality and will OOM the metric backend.
- **Logs and traces can carry high-cardinality fields.** `user_id`, `trace_id`, full URL, request body hash — these belong in logs or span attributes, not metric labels.

The decision rule for a new label: ask "how many distinct values will this field take?" If the answer is more than a few thousand, it goes on logs or traces, not on metrics. If you absolutely need to slice metrics by a high-cardinality field, use exemplars (a metric with a sample trace ID attached) or histogram queries, not labels.

Anti-pattern: a developer adds `user_id` as a Prometheus label because they want per-user latency. The label space explodes by a factor of the active user count; the metric backend falls over.

## Volume budgets

Every pillar has a cost model. The team needs an explicit budget per pillar and a way to detect when a service is over budget.

- **Metrics: cardinality budget.** A maximum number of unique time-series per service. Common starting point: a few thousand series per service, single-digit millions for the cluster.
- **Logs: bytes-per-second budget.** A maximum log volume per service. Common starting point: a few MB/s per service, with hard caps that drop the lowest-priority logs when exceeded.
- **Traces: spans-per-second budget plus sampling rate.** Tail-based sampling at the collector keeps interesting traces (errors, slow requests, randomly sampled normal traces) and drops the rest. Common starting point: 100% sampling for errors and slow requests, 1-10% sampling for normal requests at scale.

Each service owner should know their service's budget. When a new feature increases telemetry volume, the increase is a deliberate decision, not an accident discovered when the vendor bill triples.

Anti-pattern: no budgets, unlimited ingest. The bill grows quietly until someone notices it doubled, at which point a panic cardinality-pruning project lands and breaks alerts.

## Three siloed pipelines anti-pattern

The most common dysfunction: metrics in one tool, logs in another, traces in a third, no correlation IDs flowing between them. The responder, mid-incident, has to manually correlate timestamps and guess which log line corresponds to which trace.

Symptoms of the silo:

- The metrics dashboard does not link to the matching traces or logs.
- The trace UI does not link to the log lines for that trace.
- The log viewer does not show a trace ID at all, so log lines for one request can't be assembled.
- Each tool has its own auth, its own dashboards, its own owner; no shared identifiers.
- Triage time is dominated by switching tabs and copy-pasting timestamps.

The fix is incremental. You don't have to consolidate to one vendor. You do have to make the IDs flow:

- **Step 1: get trace IDs into log lines.** Every log line emitted while handling a request includes the trace ID as a structured field. This single change makes log-to-trace pivot possible.
- **Step 2: get exemplars into metrics.** A metric with an exemplar carries one sample trace ID per bucket. Click the metric, get a trace.
- **Step 3: deep-link the UIs.** Configure each tool's UI to deep-link by trace ID to the other tools. Most modern observability stacks have this; it requires configuration.
- **Step 4: shared dashboards.** Dashboards include panels backed by all three pillars side by side, so the responder doesn't switch tools to see related signals.

Anti-pattern: instead of integrating the existing three, the team buys a fourth tool that promises to "unify" them, then runs four pipelines with no integration. The new tool is a new silo.

## OpenTelemetry as the integration substrate

OpenTelemetry is the current best path to integrated pillars because it specifies a single SDK and wire format for all three pillars with shared identifiers (trace ID, span ID, resource attributes) by default.

Practical guidance:

- **Use the OTel SDK for traces first.** Tracing is where OTel is most mature and where the integration value is highest. Replace bespoke tracing libraries with OTel.
- **Use the OTel SDK for logs second.** OTel logs are newer; on some languages they wrap the existing logger to attach trace context. The win is the trace ID auto-injected into every log line.
- **Use the OTel SDK for metrics third or in parallel.** Metrics in OTel are stable but the migration from Prometheus client libraries has more friction; do it where the cardinality and exemplar story justifies it.
- **Collector in the middle.** The OTel collector receives all three pillars and routes to the backends (metrics to Prometheus or Cortex, traces to Tempo or Jaeger, logs to Loki or Elasticsearch). This is where sampling, redaction, and routing live.

The decision rule: if you're starting fresh or doing a rewrite, OTel is the default. If you have an existing stack, prioritize the trace-ID-in-logs and exemplars wins over a full migration.

## Integration tests for telemetry

A telemetry pipeline that's never been exercised end-to-end will not work the first time an incident fires. Treat the pipeline as production code with tests.

- **Synthetic request test.** A continuous job fires a known request through the system, then queries each pillar to confirm the trace, the logs, and the metric all exist and link via the same trace ID. Failure of this test is itself an alert.
- **Cross-pillar deep-link test.** From a known metric exemplar, click through to the trace. From the trace, click through to the matching logs. Each step is a verifiable hop.
- **Propagation test for every transport.** A request that crosses HTTP, then a message queue, then gRPC, then a background worker, lands as a single trace with all spans. Each transport boundary is a potential break.
- **Cardinality canary.** A monitor that watches series count per metric and alerts before the backend OOMs from a label explosion.

Anti-pattern: telemetry is "trusted because it's there" but nobody verifies the integration works. The first time someone tries to pivot from a metric to a trace mid-incident is the first time the team learns the linking is broken.

## Common anti-patterns

- **Three pipelines, no shared IDs.** The pillars exist; the responder can't compose them.
- **Trace ID not in logs.** The pivot from a log line to a trace requires guessing on timestamps.
- **High-cardinality metric labels (user_id, request_id).** Metric backend OOMs or the bill triples.
- **No budgets per pillar.** Volume grows until the vendor bill becomes an incident.
- **Context not propagated across the message bus.** Traces end at the producer, restart at the consumer with no linkage.
- **Span attributes used for per-line events.** Spans become unreadable; the proper place is logs.
- **Log fields used for request-scoped attributes that need to be on the trace.** Latency-by-tenant analysis becomes impossible because the trace doesn't carry the tenant.
- **Tail-sampling not deployed at scale.** 100% trace sampling everywhere; the trace backend is the cost driver.
- **Buying a fourth tool to "unify" three unintegrated ones.** The new tool is a new silo.
- **No integration tests.** The pillars compose only in theory; first real attempt is mid-incident.

## Output format

When this skill is invoked to design, audit, or fix observability, structure the output as:

1. **Inventory.** What's emitted from each pillar today, which tool stores it, who owns it.
2. **Correlation gap.** Where the IDs don't flow (which transport boundary, which pillar lacks trace ID, which dashboard doesn't link).
3. **Cardinality and volume audit.** Which metric labels are high-cardinality, which logs are over budget, what the sampling rate is.
4. **Integration plan.** The sequence: trace ID in logs first, exemplars in metrics next, deep-linking UIs, shared dashboards.
5. **Budgets per service.** Cardinality budget for metrics, bytes-per-second for logs, spans-per-second for traces.
6. **Tests.** The synthetic-request test, the propagation test, the cardinality canary.
7. **Ownership.** Who owns the pipeline, who reviews telemetry changes in service PRs.

## Related skills

- `slo-design` — the SLI calculation pulls from metrics; the percentile latency comes from histograms which are themselves a cardinality choice.
- `monitoring-and-alerting` — alert rules read from metrics and may include trace exemplars in the alert payload for direct pivot.
- `incident-response` — the responder uses the pillars; integration quality determines triage speed.
- `runbook-writing` — runbooks reference dashboards, queries, and traces; broken correlation means broken runbooks.
- `logging-discipline` — what to log and how to structure log fields, including trace context.
- `logging-platform-selection` — choosing the backend, with attention to whether it accepts trace IDs and integrates with the trace store.
- `performance-profiling` — profiling complements traces for in-process detail.
- `root-cause-analysis` — RCA depends on being able to follow the request end-to-end; integration quality determines RCA speed.
