---
name: logging-discipline
description: Use when deciding what to log, at what level, and in what shape — designing logging for a new service, fixing a noisy or empty log stream, or auditing PII risk in logs. Triggers when the user mentions "what should I log", "log level", "structured logging", "log everything", "PII in logs", "correlation IDs", "noisy logs", "log volume", "log sampling", or "trace ID". The skill covers structured-over-free-text, level discipline, correlation IDs, PII redaction, volume budgeting, and the 2am-diagnosis filter. For alerts on top of logs, see monitoring-and-alerting. For the broader observability strategy, see performance-profiling.
metadata:
  version: 0.1.0
---

# Logging discipline

A log line is a record from the past, written by code that didn't know it would be needed, read by an engineer who doesn't have time to read most of it. Done well, logs are the substrate of incident diagnosis and the only durable record of what the system actually did. Done poorly, logs are an undifferentiated firehose that costs money to store, returns nothing on search, and quietly leaks PII into a permanent audit trail.

The discipline is to log in a way that's actionable at 2am, parseable by machines, redacted of secrets and PII, and budgeted so the system can afford the volume.

## When to invoke this skill

- Designing logging for a new service or a major refactor.
- Investigating a noisy log stream where the signal is lost in the noise.
- Investigating a quiet log stream where the diagnostic information you need isn't there.
- After an incident where the post-mortem says "we couldn't tell what was happening from the logs".
- After a PII / compliance review flagged log content as a risk.
- After the log bill jumped and someone asked what's driving it.

The signal that you need this skill: an engineer in an incident says "I can't tell what this service was doing", or a security review says "we're logging customer emails in cleartext", or finance says "the log bill is now 30% of infrastructure spend".

## Structured over free-text

Every log line should be a parseable record, not a sentence. The minimum shape:

- Timestamp (UTC, ISO 8601, with sub-second precision).
- Level (ERROR / WARN / INFO / DEBUG / TRACE).
- Service name and version.
- Message — the human-readable summary.
- Structured fields — key-value pairs for the variables that matter.
- Correlation identifiers — request ID, trace ID, user ID hash.

Compare:

- Free-text: `User [redacted email] placed order 12345 for $42.00 — payment failed (declined)`
- Structured: `{level: INFO, msg: "order_payment_failed", order_id: "12345", user_id_hash: "abc...", amount_cents: 4200, reason: "declined", request_id: "req_xyz"}`

The free-text version is unsearchable for "all failed orders today" or "all orders by user with hash abc". The structured version is. Multiply this by every event the system emits and the difference is the difference between a useful log and a wall of text.

The message field should be a short event identifier (`order_payment_failed`, not "the order payment for order 12345 just failed because..."). Variables go in the structured fields, not interpolated into the message. This lets you group, count, and filter by event identifier without parsing prose.

## Level discipline

Five levels, each with a specific meaning. The most common failure is logging too much at INFO or treating WARN like INFO.

- **ERROR.** Something went wrong that requires human attention or affected a user. An unhandled exception, a request that 5xx'd, a database call that timed out and the user didn't get a response. The on-call should be able to scan the ERROR stream and find every actionable incident signal.
- **WARN.** Something unusual that did not require immediate intervention but may need attention later. A retry succeeded after one failure, a deprecated code path was hit, a fallback was used. WARN is for "this is worth looking at if you're auditing", not "this is broken right now".
- **INFO.** Normal business events that someone might care about retrospectively. Order placed, user signed up, deployment started. Not every function call; only events you'd want to be able to count or reconstruct later.
- **DEBUG.** Detailed execution flow useful when debugging a specific issue. Off by default in production; sometimes turned on for a specific service or request.
- **TRACE.** Every-function-call detail. Almost never on in production. Useful in development, occasionally on for a single request via dynamic logging.

The rule of thumb: if every request emits more than a handful of INFO lines, you're at DEBUG-level verbosity tagged as INFO. The cost is real (storage, indexing, the engineer's attention) and the value is low.

WARN deserves a specific check: if a WARN never gets investigated, it should be downgraded to INFO. WARN that nobody acts on becomes ignored, and the moment a real warning fires it gets ignored too.

## The 2am filter

For every log line you're about to emit, ask: "if I'm on-call at 2am and I land on this line, will I know what to do?" The filter rejects:

- Log lines with no event identifier (just a stack trace, or a generic "error occurred").
- Log lines without enough context to identify the user, request, or operation affected.
- Log lines that are pure noise ("entering function foo").
- Log lines that say something failed but not why, or why but not what.

A good 2am log line tells you:

- What happened (event identifier).
- What was affected (user / request / resource ID).
- Why it happened (error code, exception type, reason).
- What action, if any, is implied.

If you can't pass this filter, either fix the log line or downgrade its level.

## Correlation IDs

You cannot reconstruct a request from logs unless every line tied to that request has a common identifier. The standard set:

- **Request ID.** Unique per inbound request, generated at the edge, propagated to every downstream service via header (e.g. `X-Request-Id`). Logs from all services touching this request can be assembled by request ID.
- **Trace ID.** OpenTelemetry / W3C trace context. Cross-service distributed tracing identifier. Often the same shape as request ID; sometimes separate.
- **User ID hash.** A hash of the user ID — never the raw user ID or email. Lets you filter "all logs for this user today" without exposing PII in the log stream.
- **Session ID hash.** Same treatment for the session identifier.
- **Tenant ID.** In a multi-tenant system, every log line tagged with the tenant so cross-tenant searches can be excluded.

Generate the request ID at the edge (load balancer, API gateway, ingress). If you start it inside the application, you've lost the request ID for anything upstream and you'll have a gap in the trace. Propagate it through every async boundary — queue messages, background jobs, retries — by passing it as part of the payload.

Without correlation IDs, debugging an incident becomes "let me find the right log line by timestamp" — a manual scan that doesn't scale.

## PII redaction at the logger layer

The wrong place to redact PII is in the log line. The right place is in the logger layer, applied centrally.

- Define a list of fields that are PII (`email`, `phone`, `ssn`, `credit_card`, `address`, `name`).
- The logger checks every structured field name against the list and redacts or hashes the value automatically.
- Free-text messages are scanned for PII-shaped strings (email regex, credit card pattern) and redacted.
- The redaction policy is configurable per environment — sometimes dev wants raw values for debugging; prod never does.

Why centralization matters: a hundred call sites will not all remember to redact. One logger layer can. The PII review becomes "is the logger config correct?" rather than "did every developer redact in every call site?"

A specific failure to watch for: logging the entire request body for "diagnostic" purposes. The request body often contains PII (the user's email, the user's address). Don't. Log the request ID, the route, the response code, the latency. The body, if you need it for diagnosis, is a sampled detail behind a flag.

Hashes vs redaction:

- **Redact (`****`).** When you don't need to correlate. Easier; less risk.
- **Hash (`hash(user_id)`).** When you need to correlate across logs but not see the raw value. Use a hash with a salt so different services can't trivially reverse it; rotate the salt periodically.

## Log volume budget

Logs are a paid product. The math:

- Bytes per line (with overhead): 200-1000 bytes.
- Lines per request: depends on level discipline.
- Requests per day: known from production traffic.
- Storage / indexing cost per byte: known from the vendor.

Multiply through. A common surprise: a service emitting 20 INFO lines per request at 1000 rps generates 1.7 billion lines per day. At 500 bytes each, that's 850 GB / day. At $0.50/GB indexed, that's $425 / day, $13k / month, $155k / year. From one service. The level discipline above is not just aesthetic — it's a budget item.

Specific levers when the bill is too high:

- **Drop DEBUG and TRACE in prod entirely.** They're usually 80% of the volume; you almost never read them in aggregate.
- **Downgrade noisy INFO to DEBUG.** "Entering function foo" is not an INFO.
- **Sample high-volume paths.** A health-check endpoint hit 1000 times a second doesn't need 1000 log lines — sample 1 in 100 with a sampling-rate field for accurate counting.
- **Separate high-volume from low-volume streams.** Audit logs (small, must-keep) and request logs (large, can-rotate) into different stores with different retention.
- **Retention policy.** Hot storage for 7 days, archive for 30 days, delete after. Compliance may extend this; most operational debugging is within 24 hours.

## Sampling for high-volume paths

For hot paths, log every event is unaffordable. The pattern:

- Tag the log with `sample_rate: 100` (meaning "we kept 1 in 100"). The downstream tool multiplies counts by sample rate for accurate aggregation.
- Sample by request ID hash so the sampling is consistent — either you have all logs for this request or you don't. Random per-line sampling produces orphan log lines that can't be assembled into a request trace.
- Sample more aggressively for normal paths and not at all for errors. The error path is rare and high-signal; the success path is common and low-signal.
- For tail-based sampling (sample a trace IFF it had an error or was slow), the decision is made after the request — sampling becomes "keep this trace because it surfaced something interesting".

## The diagnose vs leak tension

The tension: log enough that you can diagnose, but not so much that you're leaking. The middle path:

- Log the IDs (request, user hash, order, tenant). With the IDs you can join to other systems with proper access control.
- Don't log the contents. Email, address, full payload, raw query.
- For diagnostic detail, use a separate channel — a debug log behind a flag, a trace sample, a profile.
- Audit what's in the logs periodically. Add the audit to a recurring cadence.

A specific risk: third-party errors that include the user's data in the error message. If a downstream API returns "failed for user [some email]", logging that error message logs the email. Strip or redact the message; log a generic error string with the user_id_hash.

## Dev-time vs prod-time logging

The same code runs in dev and prod, but the logging policy differs:

- **Dev.** Verbose, unsalted, pretty-printed for the human eye. DEBUG / TRACE on. Stack traces inline.
- **Prod.** JSON-structured, redacted, level-disciplined (INFO and above, mostly), sampled where hot.

The logger config — not the log call sites — is what differs. The call sites are identical. This means an engineer locally sees rich detail; a prod log stream is parseable and redacted.

A common antipattern: leaving pretty-print and stack-trace-inline on in production. Logs are no longer parseable; the log stream is for humans, not for tools, and the tools fall back to text search.

## Output format

When this skill is invoked to design or audit logging, structure your output as:

1. **Current state assessment** — structured or free-text, levels in use, correlation IDs, PII redaction.
2. **Level audit** — top emitters by level; recommendations to downgrade or drop.
3. **Correlation ID plan** — what IDs propagate where; gaps at async boundaries.
4. **PII risk** — fields that are at risk; redaction-layer recommendation.
5. **Volume budget** — current rate, current cost, levers to apply.
6. **Sampling plan** — for hot paths; the sample rate and the sampling key.
7. **Retention** — hot / warm / cold tiers; compliance constraints.

## Log retention and compliance

Retention is its own design decision:

- **Operational retention.** Logs needed for debugging recent incidents. 7-30 days is typical. Hot storage with fast search.
- **Audit retention.** Logs needed for compliance, security investigations, or regulator response. Months to years depending on industry. Cold storage; slower access; cheaper.
- **PII boundary on retention.** A log that contains PII may have a maximum retention dictated by privacy law (GDPR right to erasure complicates indefinite retention). Either don't log the PII or set a hard retention ceiling.
- **Immutable for compliance.** Some compliance regimes require logs that cannot be tampered with. Write-once storage, cryptographically signed batches, or vendor-attested immutability.

The retention policy is a legal-and-finance-and-ops three-way negotiation. Don't decide unilaterally; verify with legal for regulated data.

## Logs as part of observability

Logs are one of three observability pillars (the others are metrics and traces). The right division:

- **Metrics.** Numeric, low-cardinality, aggregated. "Request count by status code by service." Cheap, queryable, the basis of alerts.
- **Traces.** Per-request, structured, distributed. "This request hit service A, then B, then C; here are the timings." The basis of latency analysis.
- **Logs.** Per-event, semi-structured, full detail. "Order 12345 failed because the payment provider returned X." The basis of debugging the specific.

The principle: don't reach for logs when a metric would do. A counter incremented in code is cheaper than emitting a log line per event and aggregating it downstream. Logs are for the events you'd want to read individually; metrics are for the events you'd want to count.

The most common antipattern is using logs for metric-like questions. "How many orders today?" should be a metric. "Why did order 12345 fail?" is the log question.

## Common anti-patterns

- **Free-text logs.** Messages with interpolated variables; unsearchable, unparseable. Move to structured.
- **Logging everything at INFO.** No level discipline; INFO becomes the noise floor. Engineers stop reading it.
- **Logging raw PII.** "User [some email] signed up." A leak with a permanent record. Redact at the logger layer.
- **No correlation IDs.** Two services emit logs about the same request; nobody can connect them. Generate at the edge; propagate everywhere.
- **WARN nobody investigates.** Becomes ignored, and the next real warning is also ignored. Downgrade to INFO or fix the underlying cause.
- **Logging entire request bodies.** Convenient for debugging; expensive to store; leaks PII. Log IDs and metadata, not bodies.
- **Pretty-printing in prod.** Multi-line, formatted-for-humans logs in a JSON-expecting log pipeline. Either pretty-print or structure, not both.
- **No volume budget.** The log bill is a surprise once a quarter. The engineer who added the loud INFO doesn't see the bill.
- **Random per-line sampling.** Sampled logs from a request are scattered; you can't reconstruct the request. Sample by request ID instead.
- **Stack trace as the only signal.** An ERROR with a stack trace and no context — no request ID, no user, no event identifier — is a ghost. Add the surrounding context.

## Related skills

- `monitoring-and-alerting` — alerts on top of logs use the structured fields above; without them, alerts can't be precise.
- `incident-response` — at 2am, the log stream is the primary evidence. The 2am filter above is what makes it usable.
- `performance-profiling` — when profiling under load, the log volume budget matters; high-volume DEBUG can drown the profiler.
- `security-review` — PII redaction is part of the security review for any service that handles user data.
- `local-dev-environment` — dev-side logging should match prod patterns so engineers see the same shape locally.
- `systematic-debugging` (obra/superpowers) — when debugging, the quality of the logs determines whether systematic-debugging can use evidence vs. guessing.
