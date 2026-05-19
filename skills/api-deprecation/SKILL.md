---
name: api-deprecation
description: Use when retiring an API surface — endpoint, field, header, parameter, or behavior — that has existing consumers. Triggers when the user mentions "deprecate this endpoint", "sunset this field", "remove this API", "v1 retirement", "breaking change", "deprecation timeline", "communication plan", or "they hadn't migrated". The skill covers the deprecation lifecycle (announce, mark, instrument, migrate, remove), sunset windows for internal vs public consumers, RFC 8594 Sunset/Deprecation headers, usage telemetry, and recovery when consumers don't move. For the design of the API that's now being deprecated, see api-design. For the broader release-gate question of safety in shipping these changes, see safe-public-release.
metadata:
  version: 0.1.0
---

# API deprecation

Deprecating an API surface is a problem of empathy more than engineering. The hard part is not flipping a flag — it's telling other teams or other companies that their working code will stop working, providing them a migration path, and waiting long enough that the slow movers can land before you turn the lights off. Done well, the sunset day is uneventful. Done poorly, the sunset day is an incident with paying customers who hadn't seen the email.

The deprecation lifecycle has five stages. Skipping any of them is how you end up with the "we sunset and they hadn't moved" recovery exercise.

## When to invoke this skill

- Retiring an endpoint that some consumers still use.
- Removing or renaming a field in a response payload.
- Changing the semantics of an existing parameter or header.
- Dropping support for an API version (v1, v2, etc.).
- Removing a query parameter or filter that some clients depend on.
- Migrating consumers from one authentication scheme to another.
- Sunsetting a third-party integration where you're the API provider.

If you're considering "just remove it, who could be using v1 still?" — that's the signal you need this skill. Someone is using v1.

## The five-stage lifecycle

Run all five. Each protects against a specific failure mode.

### 1. Announce

Tell the consumers, in writing, with a date. The announcement is not "we plan to deprecate this someday" — it's "as of [date] this surface is deprecated; sunset on [later date]". Without a concrete sunset date, the announcement is ignored.

Channels by audience:

- **Internal consumers (other teams in your org).** Engineering chat, the API team's announcement channel, a calendar invite for the sunset date, a tracking ticket per consumer team.
- **External consumers (partners, integrations).** Email to documented integration contact, dashboard banner if you have one, status page entry, the changelog.
- **Public API consumers (anyone with a key).** Email to every key holder, public deprecation notice on the docs, response header on every API call, the changelog.

The announcement says: what surface is deprecated, why, when sunset happens, what the migration path is, where to ask questions. If any of those is missing, the announcement is half-done.

### 2. Mark

The deprecation must be visible in the API itself, not just in a blog post. Three mechanisms:

- **Sunset HTTP header.** RFC 8594. `Sunset: Wed, 11 Nov 2026 23:59:59 GMT`. Returned on every response from the deprecated surface. Clients that read headers will see the sunset date in the response itself.
- **Deprecation HTTP header.** Draft RFC. `Deprecation: @1730000000` (unix timestamp of when the deprecation took effect). Or `Deprecation: true` for the simpler version. Signals "this is deprecated as of this time".
- **Link header to the migration guide.** `Link: <https://docs.example.com/migration/v1-to-v2>; rel="deprecation"`. Lets clients programmatically discover the migration doc.

Beyond headers, the docs themselves must mark the surface as deprecated, with the sunset date and a link to the migration guide. The OpenAPI / GraphQL schema should have the `deprecated: true` marker on the relevant fields and operations.

### 3. Instrument usage

You cannot sunset what you cannot measure. Add telemetry to the deprecated surface:

- **Request counter per consumer.** API key, OAuth client ID, IP, or whatever consumer identifier you have. The counter shows who's still calling.
- **Last-seen timestamp per consumer.** Useful for "who called this last week" and "who hasn't called in 30 days".
- **Request frequency.** Is consumer X making 1 call a month (probably automated, easy to move) or 1000 calls per minute (high-volume integration, harder to move)?
- **Endpoint-level vs version-level breakdown.** Sometimes v1 has 5 endpoints, only 2 are still called. The migration plan can differ.

Build a dashboard showing usage of the deprecated surface over time. The trend line is what you'll use to know whether the announcement reached consumers — if usage is flat after announcement, the announcement didn't land.

### 4. Migrate

Help the consumers move. The migration path is not "read the migration guide and figure it out". The escalating set of supports:

- **Side-by-side documentation.** Old call, new call, side by side with notes on the differences.
- **Sample diffs.** Before/after code in the consumer's language(s). For a public API, the major SDKs.
- **Codemod or migration script.** If the change is mechanical (rename, restructure), an automated migration. Even partial automation cuts consumer time significantly.
- **Parallel run.** The new endpoint is available alongside the old one. Consumers migrate one call at a time, shadow-comparing results. The deprecated surface stays up during the transition.
- **Hand-holding for high-volume consumers.** A direct conversation with the consumer's team. If a single customer drives 30% of the deprecated traffic, a personal call beats an email.
- **Migration deadline reminders.** At 90, 60, 30, 14, 7, 3, 1 days before sunset, automatic emails to consumers still calling the deprecated surface.

The principle: the more painful the migration, the more support you owe. A rename with a codemod available is one experience; a behavioral change with no automation is another.

### 5. Remove

The sunset date arrives. The mechanics:

- **A few days before sunset, brownouts.** The deprecated surface returns 410 Gone (or 503 with a Sunset header) for a short window, then back. Forces consumers to discover they haven't migrated, in time to scramble.
- **On the sunset date, return 410 Gone permanently.** With a body that points to the migration guide. Do NOT return 404 (suggests the surface never existed) or 500 (suggests an error). 410 Gone is the right code.
- **Leave 410 Gone for a defined grace period.** Three months is reasonable. After that, the route can be removed from the routing layer.
- **Monitor the 410 rate.** If you suddenly see a spike, a consumer just hit the wall — reach out, help them migrate.

For high-stakes APIs, the brownout pattern is essential. The first brownout is the wake-up; the consumers who hadn't seen the deprecation now know.

## Sunset windows

The window between announce and sunset depends on audience and impact.

- **Internal API, single-team consumer.** 1-2 sprints (2-4 weeks). The consumer team is in the same building; coordinate directly.
- **Internal API, multi-team consumer.** 30-60 days. Each consumer team has a backlog and a sprint cycle; allow for the slowest.
- **External / partner API.** 90-180 days. Partners have their own release cycles. They may be on monthly or quarterly releases.
- **Public API.** 6-12 months minimum. SDKs need updating, customer code needs migrating, business cases need to allow the work. The internet runs on five-year-old code; respect that.

Shorter than these windows risks an incident with paying or important consumers. Longer than these windows is fine if you can afford the maintenance burden of running both surfaces.

A specific exception: a security-driven deprecation may compress the window dramatically. If the deprecated surface is a vulnerability, the timeline is "as soon as possible safely", not "180 days". Coordinate with security; communicate the urgency to consumers.

## The "who blocks the sunset" identification

A few weeks before sunset, the usage dashboard tells you who is still calling the deprecated surface. Two outcomes:

- **Tail of long-tail consumers.** A handful of low-volume callers. Direct outreach: identify the consumer, send a personal email, offer migration support. If they don't respond, the sunset proceeds; they'll see the brownout and react.
- **A few high-volume holdouts.** One or two consumers driving most remaining traffic. Personal call. Understand why they haven't migrated — is the migration too painful, did they miss the email, are they blocked on their own roadmap? Help them; possibly extend the window if the blocker is real.

The identification is not a fail-safe; it's a courtesy. The sunset date is the sunset date. If a consumer hasn't moved by the date despite multiple notices, they bear the consequence. If you keep pushing the date, you're training consumers that deprecations are theater.

## When sunset day comes and consumers haven't moved

The recovery playbook for "we sunset and they hadn't moved":

1. **Triage who's calling.** Pull the 410-Gone telemetry. Who's hitting it, how often, who is the consumer.
2. **Decide: extend, or hold the line.** If the affected consumer is critical (a major customer, a partner with a contract clause), extend the sunset by a defined short window (1-4 weeks) and communicate explicitly. If the consumer is non-critical or unresponsive, hold.
3. **If extending, ramp.** The deprecated surface comes back on, but only for the specific consumer(s) via allow-list. Other consumers still see 410. This is an exception, not a re-opening.
4. **Post-mortem the deprecation.** What about the announce / mark / instrument / migrate stages didn't reach the consumer? The recovery is information for the next deprecation.

The most common cause: the announcement didn't reach the right contact. Integration contacts change; emails get filtered. Confirm in advance that the contact you're emailing is the engineer who will do the work, not a generic distribution list.

## Special cases

- **Schema field removal.** A removed field is a breaking change for any client that reads it. Even adding a field can break clients that validate the schema strictly. Treat any schema change with the same five-stage lifecycle.
- **Parameter behavior change.** Same endpoint, same parameters, different behavior — the silent-breaking-change category. Hardest to detect; consumers don't know to read your changelog. If you have to make a behavioral change, version the endpoint and run both behaviors in parallel.
- **Authentication scheme migration.** Old keys still work; new keys preferred; eventual sunset of old keys. Same lifecycle, longer windows (security tokens take longer to rotate than code changes).
- **Webhook payload changes.** Consumers may have hand-written parsers; a field rename can break their integration. Send both old and new fields in parallel for a window; mark old as deprecated; sunset on schedule.

## SDK and client library lifecycle

For APIs with SDKs, the SDK is the consumer-facing surface. The SDK lifecycle layers on top of the API lifecycle:

- **SDK versioning is independent of API versioning.** SDK 3.x may support API v1 and v2 simultaneously. Deprecating the API may require new SDK releases that drop support.
- **SDK release windows are slower than API release windows.** Customers upgrade SDKs on their own schedules. Plan accordingly.
- **The SDK can ease the migration.** A new SDK version can shim the old API call onto the new endpoint internally; consumers upgrade the SDK and don't see the change. This buys time but creates a new dependency on the shim version.
- **End-of-life the SDK explicitly.** When the SDK no longer supports the current API, mark it EOL with the same lifecycle (announce, support window, removal from package registries).

For language-specific SDKs, the announcement channels include the package registry (deprecate the version), the GitHub repo (issue + readme update), the docs site, and the typical email channel.

## Versioning strategy and deprecation

The deprecation discipline depends on how the API is versioned:

- **URL-versioned (`/v1/`, `/v2/`).** Easy to run multiple versions in parallel. Each version has its own deprecation lifecycle. Common for public APIs.
- **Header-versioned (`Accept: application/vnd.example.v2+json`).** Same URL, different content type. Slightly less visible to consumers; the announcement matters more.
- **Date-versioned (`?api-version=2026-01-15`).** Each request specifies the desired version. The consumer can pin to a date; the API supports multiple dates. Stripe-style.
- **Unversioned.** Every change is a breaking change. Avoid for public APIs.

Within URL-versioned, the question of "when do we deprecate v1?" is often "when we ship v2". A common pattern: announce deprecation on v2 launch, set the sunset 12 months out, instrument from day one, run both for the year, sunset v1 on schedule.

For date-versioned APIs (Stripe, GitHub), each date version is essentially its own deprecation lifecycle. The "sunset" for a date version is when it's no longer in the supported list. Long windows here (years) because customers pin to specific dates.

## The breaking-change taxonomy

Not all breaking changes are equal. Categories from least to most disruptive:

- **Additive change.** New endpoint, new field on response. Almost never breaking (unless consumers use strict schema validation).
- **Optional deprecation.** Marking a field as deprecated, no behavior change yet. Visible but harmless.
- **Hard rename or removal.** Field disappears or means something different. Breaking.
- **Authentication or authorization change.** Old tokens stop working, or different scopes required. Breaking; also requires customer credential rotation.
- **Endpoint URL change.** Path moves; old path returns 404. Breaking; consumers must update their code.
- **Behavior change without surface change.** Same endpoint, same parameters, different semantics (e.g. the API used to allow X, now rejects X). The most dangerous because consumers don't know to look for it.

The deprecation discipline scales with the category. Additive: just ship. Optional deprecation: announce and add headers. Hard removal: full five-stage lifecycle. Behavior change: version the endpoint instead of changing it silently.

## Output format

When this skill is invoked to plan a deprecation, structure your output as:

1. **Surface being deprecated** — endpoint, field, parameter, or version, with precise scope.
2. **Consumers affected** — internal, external, public; named where possible.
3. **Sunset date** — concrete date, with the announce-to-sunset window justified.
4. **Migration path** — what consumers need to do, with the support level (docs, codemod, parallel-run).
5. **Telemetry plan** — what to instrument, what the dashboard looks like.
6. **Announcement plan** — who is told, when, through what channels.
7. **Sunset mechanics** — brownout schedule, 410 Gone, grace period.
8. **Recovery playbook** — what to do if a major consumer hasn't moved by sunset.

## Common anti-patterns

- **Announcement without a date.** "We plan to deprecate this someday" is ignored. Set a date.
- **Deprecation without instrumentation.** You can't sunset what you can't measure. The usage dashboard tells you whether the deprecation is succeeding.
- **Sunset without brownout.** Consumers who weren't paying attention hit the wall on the day. Brownouts are the wake-up.
- **No migration support beyond docs.** "Read the migration guide" is the minimum; a codemod or parallel-run dramatically cuts consumer pain.
- **Sunset window too short for public APIs.** 30 days for a public API will break customers. Use 6-12 months minimum.
- **Pushing the date when consumers don't move.** Trains everyone that deprecations are theater. Hold the line; extend only by exception with explicit communication.
- **Removing the route entirely on day one.** Return 410 Gone, not 404. 410 says "this used to exist; it's gone now"; 404 says "this never existed".
- **Hard rename instead of deprecated alias.** Renaming a field without keeping the old name as a deprecated alias breaks every consumer. Run them in parallel through the sunset window.
- **Silent behavioral changes.** Same endpoint, same parameters, different behavior. Version the endpoint or instrument the new behavior; don't silently change.
- **Notification to a generic email.** "api-support@" probably isn't the engineer who will do the migration. Identify the specific human or team.

## Related skills

- `api-design` — for the design of the API that's now being deprecated. The deprecation discipline above is the lifecycle the design must support.
- `safe-public-release` — for the release-gate decision about whether the deprecation itself is safe to ship.
- `feature-flagging` — for the technique of gating the deprecated surface behind a flag during the sunset window.
- `monitoring-and-alerting` — for the dashboard that tracks deprecated-surface usage over time.
- `incident-response` — if a sunset goes wrong and breaks a consumer in production, the incident playbook applies.
- `architecture-decision-records` — the deprecation decision is often worth recording as an ADR, especially the "why" and the version-to-version evolution.
- `logging-discipline` — instrument every deprecated-surface request with structured logs that the usage dashboard reads from.
- `oncall-rotation-design` — the on-call should know which surfaces are mid-sunset, so a customer "your API just broke" page can be triaged quickly.
- `code-review-giving` — when a PR changes a public API surface, the reviewer applies this skill's discipline before approving.
