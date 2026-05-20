---
name: backup-and-restore
description: Use when designing, auditing, or testing a backup-and-restore system — choosing RPO/RTO targets, scheduling drills, verifying restores, or recovering from disaster. Triggers when the user mentions "backup strategy", "restore drill", "RPO", "RTO", "point-in-time recovery", "disaster recovery", "did the backup actually work", "we lost the database", "retention policy", or "encryption key". The skill covers RPO/RTO sizing, restore-verification cadence, dependency ordering on recovery, key recovery for encrypted backups, and the principle that a backup you haven't restored is not a backup. For the incident response when production is down, see incident-response. For the data-corruption playbook inside an incident, see incident-response's data-corruption section.
metadata:
  version: 0.1.0
---

# Backup and restore

A backup is not a backup until you have restored from it. Most teams have backups; many teams discover during their first real outage that the backups don't restore, don't decrypt, don't cover the right data, or take ten times longer than the RTO promises. The discipline of backup-and-restore is to treat the restore — not the backup — as the system. A backup that's never restored is a file that costs storage.

This skill covers RPO/RTO targets, restore-drill cadence, dependency ordering during recovery, encryption key management for backups, and the recovery playbook for the day the production database doesn't come back.

## When to invoke this skill

- Designing a backup strategy for a new system or a system that's outgrown ad-hoc backups.
- Auditing an existing strategy where the backups have never been restored, or were restored once a year ago.
- Choosing or revisiting RPO/RTO targets.
- Scheduling a restore drill (overdue if there hasn't been one this quarter).
- Recovering from a disaster — data corruption, ransomware, region outage, accidental deletion.
- After a compliance review that asks "how would you recover".
- When the backup storage bill grows enough that someone questions retention.

The signal you need this skill: somebody asks "do our backups actually work?" and nobody can answer with a recent restore.

## RPO and RTO

The two numbers that define the backup strategy.

- **RPO (Recovery Point Objective).** The maximum acceptable data loss in time. RPO = 1 hour means "we can lose up to 1 hour of data". Drives the backup frequency.
- **RTO (Recovery Time Objective).** The maximum acceptable downtime during recovery. RTO = 2 hours means "we must be back up within 2 hours". Drives the restore architecture.

Both numbers come from the business, not from engineering preference. The question is: how much data loss does the business tolerate, and how much downtime?

The cost shape:

- **RPO under 1 minute.** Requires synchronous replication. Expensive (multiple live copies, write performance impact).
- **RPO 1-15 minutes.** Requires log shipping or async replication with short lag. Moderate cost.
- **RPO 1-24 hours.** Daily snapshot is sufficient. Cheap.
- **RPO over 24 hours.** Almost always wrong. Even low-stakes systems usually lose more than 24 hours of work as a serious blow.

- **RTO under 5 minutes.** Hot standby that takes over automatically. Expensive.
- **RTO 1-2 hours.** Warm standby (data replicated, services not running, need to start). Moderate.
- **RTO 1-8 hours.** Restore from backup snapshot into a prepared environment. Cheap but assumes the snapshot exists and the environment is ready.
- **RTO over 8 hours.** Restore from cold storage. Cheapest; most disruptive.

The classic mistake is setting aggressive RPO/RTO without budget. "RPO = 0 and RTO = 0" is the wishlist that produces "we'll figure it out". Pick numbers the business actually values, and design to them.

## Backup mechanisms

The mechanism follows from the RPO/RTO targets:

- **Snapshot.** Periodic full or incremental copy. Cheap, simple, restore is "load the snapshot". RPO bounded by snapshot frequency.
- **Log shipping.** The database's write-ahead log is shipped to a backup target continuously. Restore is "load snapshot + replay logs to target time". Supports point-in-time recovery.
- **Async replication.** A continuously-updated replica lags by seconds. Restore is "promote the replica". Low RPO, low RTO, ongoing cost.
- **Sync replication.** Multi-master or active-passive with synchronous writes. RPO near zero. Write performance cost.
- **Application-level export.** Periodic dump of business-meaningful data (orders, users) as a flat file. Useful as a last-resort fallback if the database backup is corrupt; not a primary mechanism.

Most production systems combine: async replication for RPO and immediate failover, plus snapshots for point-in-time recovery and ransomware protection (a replica replicates corruption; a snapshot is a known-good past state).

## Point-in-time recovery

Snapshots give you discrete restore points. Point-in-time recovery (PITR) lets you restore to any specific moment.

- **When PITR matters.** Data corruption you discover hours later (need to roll back to before the corruption), ransomware (roll back to before encryption), accidental DELETE WHERE 1=1 (roll back to before the query).
- **How PITR works.** Snapshot baseline + log replay. Restore the snapshot, then replay the write-ahead log up to the chosen second.
- **Retention for PITR.** Typically a few days to a week. Beyond that, the log volume becomes expensive.
- **The catch.** PITR is restoring the database to a past state. Anything that happened after the restore point is gone — including transactions that legitimate users completed. The business has to decide: lose the recent good data along with the bad, or attempt a more surgical repair.

For systems with regulated or critical data, PITR is the right baseline. For low-stakes systems, daily snapshot may be enough.

## The backup-is-meaningless-without-verified-restore rule

A backup file existing is not the same as a backup working. Verify by restoring.

The minimum verification cadence:

- **Restore drill.** Quarterly minimum. Take a backup, restore it into a clean target, run the application against it, verify the data. Compare row counts, sample records, run a smoke test of business operations.
- **Automated verification.** Daily or weekly. The backup pipeline restores the latest backup into an ephemeral environment, runs a sanity check (can it open, can a sample query return), and reports pass/fail.
- **Full disaster drill.** Annually. Simulate losing the production environment; restore the entire stack from backups; measure the time it takes; confirm the RTO is met.

The drill rules:

- **Restore on a clean target, not the original.** Restoring on top of a possibly-corrupt source is how data corruption spreads. Spin up a fresh environment; restore there; compare.
- **Time the drill.** The actual time to restore is the empirical RTO. If it differs from the documented RTO, update the documentation or fix the gap.
- **Drill the worst-case.** Don't always drill the easy scenario. Periodically test "no recent snapshot, only weekly backup" or "primary region is gone, restore in secondary".
- **Document the steps.** Each drill produces or updates the runbook. The runbook is what the on-call uses at 3am.

A team that has never restored from their backups is a team that does not have backups. They have backup files.

## Dependency ordering during recovery

In a real disaster, you're restoring multiple systems. Order matters.

- **Restore the foundational data first.** Database, then anything that depends on it. If the cache restores first, it's full of stale data when the DB comes up.
- **Restart services in dependency order.** Auth before things that auth-check. Message broker before consumers. Reverse the production startup order; you usually have it documented somewhere.
- **Rebuild the cache, don't restore it.** Caches are derived data. Restoring a cache from before the disaster is restoring stale data. Let the cache rebuild from the restored DB.
- **Replay queued work where possible.** If the queue persisted, the queue's contents are replayed; in-flight processing may need manual reconciliation.
- **Restart background jobs last.** Cron jobs, scheduled tasks. They can run wrong if they fire against half-recovered systems. Restart them only when the foundation is verified stable.

The dependency graph is a recovery artifact. Document it before the disaster; trying to rediscover it under pressure is how you sequence wrong and create cascading failures.

## Encryption key recovery

A backup is encrypted at rest. A backup you can't decrypt is not a backup. The discipline:

- **Keys are stored separately from the backup data.** Same vault as the backup means losing the vault loses both. Use a separate key management system, ideally a different vendor.
- **Key rotation does not orphan old backups.** When the key rotates, either re-encrypt old backups with the new key (expensive but tidy) or maintain the old key as a recovery-only key until the old backups are aged out.
- **Recovery key access.** The set of humans who can decrypt the backups must be at least two (no single point of failure), must have credentials that don't depend on the production system being up (which it isn't, by definition, during recovery), and must be documented in the recovery runbook.
- **Key recovery drill.** Part of the quarterly restore drill. Decrypt a backup using the documented procedure. If the procedure has a gap (the vault is itself behind production auth, the documented engineer left the company), find it now, not during a disaster.

Encryption is non-negotiable for any backup of sensitive data. The retrieval-of-the-key path is the new single point of failure.

## Retention vs cost vs compliance

Retention is a three-way negotiation:

- **Operational needs.** Most operational restore is within 24 hours; some within a week. After a month, the restore is almost never the right answer (the application state has moved on; restoring loses too much intermediate work).
- **Compliance / legal.** Specific industries require retention for years (financial, healthcare, regulated industries). Some regulations require the ability to produce data from years ago.
- **Cost.** Storage at scale is real money. 7-year retention of daily snapshots is a budget item.

Common pattern: hot retention (last 7 days, fast restore), warm retention (last 30 days, slow restore), cold archive (last 7 years if required, very slow restore). The cold archive is for compliance, not operational; restoring from it is an exception event.

A specific compliance question: does your retention policy match your customer contracts and your regulators' requirements? Mismatch is a compliance event, not a technical decision. Verify with legal before designing.

## Backup security

A backup is a copy of all the data. The threats:

- **Backup theft.** An attacker accesses backup storage; they have all the data without touching production. Backups must be encrypted at rest, access-controlled, and audit-logged.
- **Backup corruption / ransomware.** An attacker corrupts or encrypts the backups so you can't recover. Air-gapped or immutable backups (write-once-read-many) defeat this — the backup is in storage that even the production system can't modify.
- **Backup tampering.** A subtle attacker changes the backup contents; the restore later is silently corrupted. Cryptographic signatures on backups; verify before restoring.
- **Recovery credentials theft.** The key that decrypts the backup is exposed. The backup is now effectively unencrypted.

For high-value targets (financial data, healthcare data), immutable backups are the new minimum. The 3-2-1 rule (3 copies, 2 media, 1 offsite) is the old rule; immutable + air-gap is the modern extension.

## The recovery playbook

When the production database is gone, the playbook:

1. **Confirm the scope.** Is this corruption, deletion, region outage, ransomware, accidental drop? The recovery path differs.
2. **Page the right people.** DBA, infrastructure on-call, the IC. For ransomware, also security and legal.
3. **Identify the restore target.** A clean environment (probably a new VM/cluster), not the corrupted original.
4. **Identify the restore source.** Latest snapshot, latest replica, last known-good point-in-time. The choice depends on scope.
5. **Decrypt and verify the backup.** Confirm it's intact before committing to restore.
6. **Restore the foundational data.** Database first. Time it; this dominates RTO.
7. **Verify post-restore.** Row counts, sample records, integrity constraints. Don't just trust the restore process completed.
8. **Restart dependent services in order.** Per the dependency graph.
9. **Rebuild caches, replay queues, restart jobs.** In that order.
10. **Communicate progress.** Per incident-response comms cadence.
11. **Post-mortem.** Including: why did we lose the data, did the backup work, did the RTO/RPO hold, what should change.

## Cross-region and multi-cloud backups

For systems with regional outage as a real risk:

- **Cross-region copy.** Backups stored in a region different from the primary. Defends against region-wide outages (a fire in the data center, a cloud-provider regional failure). Adds storage and transfer cost.
- **Multi-cloud copy.** Backups stored with a different cloud provider than the primary. Defends against single-vendor failures (a billing dispute, a vendor-level outage, vendor compromise). Adds cost and complexity.
- **The 3-2-1 rule.** Three copies of data, two media types, one offsite. The traditional rule for backup resilience. Adapt to cloud era: three copies, two providers, one immutable.
- **Recovery rehearsal in the alternate region.** A backup in another region is theoretical until you've restored from it. Drill it.

For most teams, cross-region is sufficient. Multi-cloud is for organizations with explicit policy or critical regulatory requirements.

## Backup of non-database state

Not all important state is in the database. Catalog what else needs backup:

- **Object storage.** User uploads, generated artifacts, logs in archive. Often the largest single category; restore plans must account for the transfer time.
- **Configuration.** Infrastructure-as-code, secrets, environment variables. Usually in version control plus a secrets vault; verify both are recoverable.
- **Application state outside the DB.** Cache contents that took hours to warm up, search indexes that took hours to build, message queues with persistent payloads. Decide for each: restore from backup, rebuild from primary data, or accept the warm-up cost.
- **External integrations.** API keys, OAuth tokens, third-party webhooks. Often forgotten until the disaster reveals they're not recoverable. Document the rotation/regeneration procedure.

A restore that brings up the database but loses the user uploads is partial. Inventory what state matters; plan backup for each category.

## The disaster recovery exercise

Periodic full-disaster exercises distinguish a real DR plan from a documented one. The exercise:

- **Scope it.** "Simulate losing the primary region for 4 hours; recover into secondary." Defined start, defined success criteria.
- **Schedule it.** Quarterly or annually depending on risk tolerance. Calendar it; commit to it.
- **Don't break production.** Run the exercise in a parallel environment that mirrors prod. Real failover would be a disaster of its own kind.
- **Time everything.** Restore time, service-restart time, total RTO. Compare to the target.
- **Identify gaps.** Where did the exercise reveal documentation gaps, dependency surprises, missing access? File issues; fix before the next exercise.
- **Practice the comms.** DR is not just technical; the communications during an actual disaster are part of the exercise. Stakeholders, customers, regulators.

A team that has never run a DR exercise is a team that doesn't know its DR plan. The plan and the exercise are both required.

## Output format

When this skill is invoked to design or audit backup-and-restore, structure your output as:

1. **RPO/RTO targets** — proposed numbers, with the business rationale.
2. **Backup mechanism** — snapshot / log shipping / replication / combination, matched to the targets.
3. **PITR coverage** — yes/no, and the retention window.
4. **Restore drill cadence** — quarterly minimum, with the documented procedure.
5. **Dependency graph** — restore order for a full-stack recovery.
6. **Encryption and key recovery** — where keys live, who can decrypt, drill plan.
7. **Retention tiers** — hot / warm / cold, with the compliance and cost rationale.
8. **Security posture** — encryption, immutability, audit logging, air-gap.

## Common anti-patterns

- **Backups exist but have never been restored.** Files, not backups. Schedule a restore drill this quarter.
- **The drill that always restores the easy case.** Test the worst case sometimes.
- **Restoring on top of the original.** Spreads corruption; loses the evidence. Use a clean target.
- **Cache restored alongside the database.** Stale data feels like fresh data; debug nightmare.
- **Backup encryption keys in the same vault as the backups.** Lose the vault, lose both. Use a separate KMS.
- **Recovery credentials depend on production being up.** The vault's auth is the production SSO; production is down; you cannot get the key. Use independent recovery credentials.
- **RPO/RTO set without business input.** Wishful numbers that don't match what was bought.
- **Snapshot but no PITR.** Data corruption you discover hours later is not recoverable. Add log shipping.
- **The undocumented dependency graph.** Recovery sequence rediscovered under pressure; sequencing wrong cascades failures.
- **Retention policy that doesn't match compliance.** Either non-compliant or overpaying. Verify with legal.
- **Backups not air-gapped.** Ransomware encrypts the backups too. Immutable or air-gapped backups are the modern minimum.
- **No verify step post-restore.** Trusting the restore process completed without checking row counts and sample integrity.

## Related skills

- `incident-response` — when production is down and recovery is the mitigation, the incident playbook frames the operation. The data-corruption subsection there is specifically aligned with this skill.
- `monitoring-and-alerting` — alerts on backup success/failure should fire; a silent backup failure is a future incident.
- `architecture-decision-records` — RPO/RTO decisions and the backup strategy are ADR-worthy. Future operators read the ADR to understand the cost shape.
- `threat-modeling` — backup as an asset and an attack surface. Backup tampering and theft are part of the threat model.
- `security-review` — encryption at rest, key management, access control are the standard security-review checks applied to the backup path.
- `safe-public-release` — the release process should not break backups (e.g. a schema change that makes the old snapshot unrestorable). Verify backup compatibility through releases.
