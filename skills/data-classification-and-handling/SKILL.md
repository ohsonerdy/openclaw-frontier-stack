---
name: data-classification-and-handling
description: Use when assigning a data tier to a new dataset, deciding what storage and access controls a field needs, or auditing whether the team's current handling of sensitive data meets the policy. Triggers when the user mentions "data classification", "PII", "personally identifiable information", "data tiers", "public internal confidential restricted", "data retention", "data handling policy", "right to be forgotten", "data access controls", "audit log for data access", "what data can we store", "encryption at rest", "field-level encryption", or "we have customer data in a debug log". The skill covers the four-tier classification scheme, PII handling specifics, retention rules per tier, access controls including audit logging, and the anti-patterns that arise when classification is treated as compliance theater. For threat modeling around data exposure, see threat-modeling. For secrets storage, see secrets-management. For the security review of changes that touch sensitive data, see security-review.
metadata:
  version: 0.1.0
---

# Data classification and handling

A data classification scheme exists so that the team can answer a single question: "this field is going into this storage, accessed by this code path, retained for this long — is that okay?" Without classification, every data question is a one-off negotiation that depends on who's in the room. With it, the question has a procedural answer.

The discipline is to assign every dataset a tier, attach the tier's rules to the storage and access path, and enforce them through the tooling rather than through reminders. A classification scheme that lives only in a wiki page is decoration; one that's enforced by the data pipeline, the storage layer, and the access tooling is real.

This skill covers a workable four-tier scheme (public, internal, confidential, restricted), the specific handling rules for PII, retention requirements per tier, access controls including audit logs, and the failure modes when classification is treated as compliance check-the-box rather than design discipline. For the security review of changes touching sensitive data, see security-review. For the threat-modeling exercise that informs which controls are needed, see threat-modeling.

## When to invoke this skill

- Designing a new dataset or table and deciding what tier it falls into.
- Reviewing a PR that introduces a new field with potentially-sensitive content.
- Auditing existing storage for misclassified or unclassified data.
- Designing the retention policy for a new data store.
- Setting up access controls and audit logging for a sensitive store.
- Responding to a deletion request (GDPR right-to-be-forgotten, CCPA delete request).
- Triaging a discovery that PII is in logs, metrics, or another unintended place.
- Onboarding a new vendor or service that will process sensitive data.

## The four-tier scheme

A workable scheme has four tiers. More tiers add bureaucracy without adding clarity; fewer tiers collapse meaningfully different data into one bucket.

- **Public.** Data that is intentionally exposed to anyone, including unauthenticated visitors. Examples: marketing copy, public documentation, published product specs, public-facing pricing pages. Disclosure is the intended state.
- **Internal.** Data that is not for external publication but has no specific protection requirements. Examples: internal team documentation, non-sensitive operational metrics, system architecture diagrams. Disclosure would be embarrassing but not damaging.
- **Confidential.** Data whose exposure would cause material harm — to users, to the business, or to a third party. Examples: customer business data, internal financial figures, vendor contracts, source code under proprietary license. Disclosure requires explicit authorization.
- **Restricted.** Data subject to legal, regulatory, or contractual protection. Examples: personally identifiable information (PII), payment card data, health records, authentication credentials, government-issued identifiers. Disclosure is a regulatory or legal event.

Every dataset receives one tier label. Mixed-tier datasets are split or upgraded to the higher tier; "mostly internal with a few PII fields" is a restricted dataset until proven otherwise.

The decision rule for tier assignment: pick the highest applicable tier. When in doubt between two tiers, choose the more protective one and re-evaluate when the use is clearer.

## PII specifics

Personally identifiable information is a special case within the restricted tier and deserves its own handling.

PII is any data that identifies a specific individual, directly or in combination. Direct PII: name, email address, phone number, government ID, account credentials. Indirect PII: IP address, device fingerprint, location, behavioral patterns that combined identify a specific person.

PII handling rules in addition to the restricted-tier defaults:

- **Minimization.** Collect only what's needed for the stated purpose. The collected field has to map to a specific use case; data collected "just in case" is a liability.
- **Purpose limitation.** Use the data only for the purpose it was collected for. Repurposing requires new consent.
- **Field-level access.** Even within an authorized service, individual fields may have different access tiers. The customer service tool may need name and email but not government ID; partition access at the field level, not the record level.
- **Pseudonymization where possible.** Store an internal user identifier and join to PII only when needed. Most analytics and operational queries can use the pseudonymous ID.
- **Deletion on request.** Be able to delete a specific user's PII across all systems on request. This requires knowing where the data is — which requires classification.
- **Cross-border restrictions.** Some PII is subject to data-residency laws (must stay within a region). The storage and replication setup needs to honor these.

Anti-pattern: PII collected as part of a generic event log, then realizing the log has to be searched and deleted per-user across years of data. Design for deletability from the start.

## Retention by tier

Retention is the time the data is kept before it's deleted. Long retention is convenient for analytics; it's also an expanding liability surface.

Default retention by tier:

- **Public.** Retention is a publishing decision, not a privacy one. Often kept indefinitely.
- **Internal.** Default retention of 1-3 years, or until business need expires. Stale internal data is removed to reduce clutter and breach impact.
- **Confidential.** Retention bounded by business need. Often 1-7 years for operational records; financial records may be kept longer for regulatory reasons. Defined per dataset, not a single number.
- **Restricted.** Retention bounded by the shortest of: regulatory requirement, legitimate business need, user consent. Often the legal minimum is what to keep; anything beyond requires justification.

Specific retention practices:

- **Event logs that may contain PII.** Default short retention (30-90 days) unless there's a specific reason for longer. Long-retention copies should have PII redacted.
- **Backups.** Backups are themselves subject to retention. A user delete request has to propagate to backups, either by deleting the backup or by tagging it and skipping the user's record on restore.
- **Derived data.** Analytics aggregates derived from restricted data inherit a constrained tier until the aggregation is provably non-identifying.
- **Soft-delete vs hard-delete.** Soft-delete keeps the data with a flag; hard-delete removes it. For restricted data, deletion requests usually require hard-delete within a defined window (30-90 days is common).

Anti-pattern: keeping everything forever because storage is cheap. Storage is cheap; breach liability scales with what's stored. The retention policy is a risk-management decision, not a cost decision.

## Access controls

Access control to sensitive data has three layers, each with its own configuration.

- **Authentication.** Who is asking. SSO, service accounts, machine identity. The identity has to be verifiable, not just claimed.
- **Authorization.** Whether that identity is permitted for this data. Role-based, attribute-based, or per-resource. The principle of least privilege: identities receive the minimum access needed for the task.
- **Audit logging.** A durable record of who accessed what, when, and for what reason. The log itself is restricted-tier; access to the audit log is a separate, narrower set of identities.

Practical rules:

- **Service-to-service.** Each service has a distinct identity, not a shared one. The audit log can attribute the access to a specific service.
- **Human access.** Operators have individual identities, not shared ones. Access requires a documented reason (ticket number, support case ID) recorded in the audit log.
- **Just-in-time access.** Sensitive data access is granted for a bounded window (hours, not days) with auto-revocation. Standing access to restricted data is rare and reviewed periodically.
- **Break-glass procedures.** Emergency access for incidents follows a defined procedure with extra audit and post-hoc review. Break-glass is not a routine access path.

Anti-pattern: a shared service account with broad access used by multiple services and operators. The audit log says "service-account did it" with no further attribution; the access is uninvestigable.

## Audit log requirements

The audit log answers "who accessed this data, when, and why" with enough detail to investigate after the fact.

Minimum fields per audit entry:

- **Timestamp.** Precise to the second or better.
- **Identity.** The specific user or service account, not a group.
- **Action.** Read, write, delete, export. The verb matters because different actions have different risk.
- **Resource.** What was accessed — table, record, field set. If field-level granularity exists, log it.
- **Justification.** A ticket number, support case, or approval reference. For service-to-service, the originating request or job.
- **Outcome.** Success or denial. Denied attempts are also informative.
- **Source.** IP, user agent, network path. Useful for detecting anomalous patterns.

The audit log is:

- **Immutable.** Cannot be edited or deleted by the actors it records. Append-only storage with separate operational ownership.
- **Long-retention.** Audit logs are typically retained for years, longer than the operational data they record.
- **Monitored.** Anomalous access patterns (volume spikes, off-hours access, broad scans) trigger alerts.
- **Reviewed.** A periodic review process (quarterly) confirms the log is being written, that anomaly alerts work, and that no gaps exist.

Anti-pattern: audit log enabled but never read. The log records the breach in real-time; nobody notices for months because no one is looking.

## Where sensitive data leaks

The discipline of classification fails most often not in the primary store but in the places where data spills sideways:

- **Application logs.** A debug log line that dumps the request body, including PII fields. The log file is not classified the same as the database, so the PII silently downgrades.
- **Metrics and traces.** A high-cardinality field that happened to be PII attached to a metric label or span attribute. Now the observability backend has PII it wasn't classified for.
- **Error reports.** Stack traces with local variables that include the request context. The error tracker becomes a PII store.
- **Caches.** A response cache that holds PII at the API layer; the cache's retention and access controls may not match the database's.
- **Backups.** Backups of restricted-tier data may live in a different system with different access controls and retention.
- **Local development environments.** Engineers pull production data into local for debugging. The local machine is the lowest-security tier in the org.
- **Exports and reports.** A CSV export of a query result; the CSV ends up on someone's laptop or in shared storage.
- **Vendor pipelines.** Data sent to an analytics or marketing vendor; the vendor's controls may not match yours.

The mitigation for each leak path:

- **Logs and traces.** Block PII at the source via SDK filters, redaction at the collector, or schema-enforced field allowlists.
- **Error reports.** Configure the error tracker to drop or hash request payloads; review captured fields periodically.
- **Caches.** Inherit classification from the data they hold; same access controls and retention.
- **Backups.** Subject to the same classification; restore tests confirm the deletion propagation works.
- **Local dev.** Restricted data is not pulled into local; use synthetic fixtures or in-place tooling that doesn't extract.
- **Exports.** Exports of restricted data are logged, expire, and are auditable. Bulk exports require explicit approval.
- **Vendors.** Vendor onboarding includes a classification review of what's sent and a contractual handling requirement.

The decision rule: for every place data moves, the destination inherits the source's tier unless there's a documented, audited transformation that reduces the sensitivity.

## Discovery of misclassified data

A working classification scheme includes a way to find data that's in the wrong place.

- **Schema scans.** Automated tooling that scans schemas for likely-PII patterns (column names like `email`, `phone`, `ssn`, `tax_id`) and flags them for classification review.
- **Content scans.** Sampled scans of stored values matching PII regex patterns (email format, phone format, credit card). False positives are expected; the goal is to surface unclassified PII for human review.
- **Log scans.** Periodic sampling of application logs looking for PII-shaped values. Alerts if found above a threshold.
- **Access pattern analysis.** Identities accessing data they don't normally touch is a discovery signal.

The discovery process feeds back into the classification register. New PII findings are either reclassified, redacted, or removed.

Anti-pattern: a classification register that's maintained by hand once and then frozen. Schema drift means the register is wrong within months; periodic scans keep it honest.

## Common anti-patterns

- **Unclassified data.** Every dataset must have a tier; "uncategorized" defaults to the highest applicable tier.
- **Compliance theater.** A classification policy in a wiki that's not enforced by tooling. The policy passes the audit; the data isn't actually protected.
- **PII in logs.** Debug logs dump request bodies; the log file is a PII store with no controls.
- **Long retention by default.** Storage is cheap, so everything is kept; breach impact scales with retention.
- **Shared service accounts.** Audit log can't attribute access to a specific person or service.
- **No just-in-time access.** Standing access to restricted data; one compromised credential is broad exposure.
- **Audit log never read.** The breach is recorded but unnoticed.
- **Vendors classified as out-of-scope.** Data sent to a vendor; vendor's controls don't match; classification is meaningless at the boundary.
- **Local dev pulls production.** Engineers debug with real PII on their laptops; the laptop is the org's lowest-security tier.
- **Deletion not designed for.** First GDPR request triggers a multi-week archaeology project across systems.

## Output format

When this skill is invoked to classify, audit, or fix data handling, structure the output as:

1. **Dataset inventory.** Each dataset with its current tier (or unclassified).
2. **Tier assignment with reasoning.** For each dataset, the chosen tier and what makes it that tier.
3. **PII inventory.** Specific PII fields, where they live, and whether they're protected as restricted.
4. **Storage controls.** Encryption at rest, encryption in transit, access controls per tier.
5. **Retention policy.** Time bounds per tier and per dataset; how deletion propagates to backups.
6. **Access model.** Who can read, who can write, just-in-time vs standing, break-glass procedure.
7. **Audit log configuration.** Fields captured, retention, monitoring, review cadence.
8. **Leak-path audit.** Logs, metrics, traces, error reports, caches, exports, vendors — confirm each respects the source tier.
9. **Discovery process.** Schema scans, content scans, periodic audit; how new misclassifications are surfaced.

## Related skills

- `threat-modeling` — informs which threats the classification controls have to defend against.
- `secrets-management` — credentials and keys are a restricted-tier asset with their own specialized handling.
- `security-review` — the review of changes that touch sensitive data; classification is the input.
- `logging-discipline` — what to log and how to keep sensitive fields out of logs.
- `backup-and-restore` — backup retention and restore must respect classification, including deletion propagation.
- `incident-response` — a data breach is an incident; the response is shaped by the data tier exposed.
- `monitoring-and-alerting` — anomalous access patterns surface via metrics; the alert is the discovery signal.
- `change-management-policy` — changes that touch restricted data have a higher review tier by default.
