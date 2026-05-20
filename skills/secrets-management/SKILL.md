---
name: secrets-management
description: Use when designing how secrets are stored, rotated, audited, and recovered — picking a vault, setting rotation cadence, building breakglass procedures, or responding to a leak. Triggers when the user mentions "rotate this secret", "secrets management", "vault setup", "breakglass", "key rotation", "AWS Secrets Manager", "1Password Connect", "HashiCorp Vault", "secret leaked", or "secrets in code". The skill covers vault selection, rotation cadence by secret type, KEK/DEK design, the post-leak runbook, and the question of where the secret comes from at runtime. For the broader release workflow that secrets live inside, see safe-public-release. For the audit pass that catches secrets in git history, use verified-history-scan.
metadata:
  version: 0.1.0
---

# Secrets management

A secret is a string whose disclosure costs money or harm. Treat it that way. The discipline is to know where every secret lives, who can read it, when it was last rotated, and what the recovery path is when the system holding the secret is itself unavailable. Most teams have a vault; fewer teams can answer those four questions for every secret in production.

This skill is the design layer. The hands-on rotation of a specific secret is downstream of the design; if you don't know the rotation cadence or the breakglass path, the rotation itself is improvised.

## When to invoke this skill

- Picking a secrets vault for the first time or migrating between vaults.
- Setting up a rotation policy for a new class of secret.
- Designing the breakglass path for the day the vault itself is down.
- Responding to a suspected or confirmed secret leak.
- Auditing the existing inventory of secrets and finding the ones with no rotation history.
- Removing secrets that snuck into source control.
- Building or reviewing the runtime path that pulls secrets into a process.

## Vault selection

The vault is the system of record. The choice is more consequential than it looks because the vault becomes a dependency of every system that uses secrets.

The selection axes:

- **Managed vs self-hosted.** A managed vault (AWS Secrets Manager, GCP Secret Manager, 1Password Connect, Doppler) trades operational ownership for vendor lock-in and per-secret cost at scale. Self-hosted (HashiCorp Vault, Bitwarden self-host, OpenBao) trades engineering time for control and zero per-secret marginal cost. Default to managed until the cost line or compliance line crosses a threshold; self-host is a real ongoing job.
- **Blast radius of compromise.** If an attacker gets read access to the vault, what do they get? A vault scoped per-environment limits the blast radius. A single vault that holds prod, staging, and dev secrets is one credential away from total compromise. Segment by environment at minimum; segment by service for high-blast-radius secrets.
- **Audit log quality.** Every read of a secret should be logged with who, what, when, and from where. If the vault's audit log is opaque or non-exportable, you cannot reconstruct who read what after a suspected breach. This rules out some hosted password managers for production use.
- **Programmatic access path.** How does a running process get a secret? SDK, sidecar, file mount, environment variable. Each has different failure modes. SDK couples the application to the vendor; sidecar adds an infrastructure dependency; env vars leak into core dumps and child processes; file mounts require careful permission handling.
- **Quorum and recovery.** What happens if you lose the master credentials to the vault itself? A vault you can't recover is a vault that becomes a single point of failure. Some self-hosted options (Vault unseal keys, Shamir secret sharing) require N-of-M humans to recover.

The selection matrix collapses to: managed for default, self-hosted if compliance or cost forces it, sharded for high-blast-radius secrets, never one vault for everything.

## Rotation cadence by secret type

Not every secret rotates on the same clock. The cadence depends on (a) blast radius, (b) attacker dwell time tolerance, (c) cost of rotation.

- **High-blast-radius, low-cost-to-rotate.** Cloud provider IAM keys, database admin credentials, signing keys for short-lived tokens. Rotate every 30 days. The system has to be designed to make rotation cheap; if it isn't, the system is the bug.
- **Medium-blast-radius, medium-cost.** Application API keys to external vendors, internal service-to-service credentials, TLS certs for internal services. Rotate every 90 days. Automate the rotation so it doesn't depend on a human remembering.
- **Lower-blast-radius, harder-to-rotate.** Encryption keys for data at rest (rotation requires a re-encrypt), root certificates, long-lived OAuth refresh tokens. Rotate every 365 days. The rotation itself is a project, not a button.
- **One-time, never-rotated.** A few legitimately exist (e.g., entropy seeds for KDFs, key-derivation salts). Document explicitly which ones these are. The default is "rotates"; "never rotates" requires justification.
- **Breakglass credentials.** Special category. Rotate after every use, on a schedule, and on every personnel change.

The rotation cadence is a contract; document it, monitor it, and alert when a secret blows past its rotation date.

A specific failure mode: secrets that should rotate but can't, because the system that consumes them isn't designed for rotation. The fix is to fix the consumer, not extend the rotation window indefinitely. A 5-year-old API key is a 5-year exposure window.

## Where the secret comes from at runtime

Decide explicitly. The options:

- **Environment variable, set by the orchestrator.** Common, simple. Risks: env vars leak into core dumps, child process listings, error reports, debug interfaces. Acceptable for low-blast-radius secrets in well-controlled processes.
- **File on disk, mounted by the orchestrator.** A secret file with strict permissions, mounted by Kubernetes / systemd / container runtime. Better than env vars because file permissions can restrict the read to the right uid. Risk: file persists across crashes and may be readable by attacker with disk access.
- **API call to the vault, at process startup.** The process boots, calls the vault, caches in memory, runs. Risk: vault must be available at startup; if vault is down, the service can't start.
- **API call to the vault, on every use.** Highest security, lowest performance. Used only for very-high-blast-radius secrets where caching is unacceptable.
- **Sidecar that fetches and serves locally.** A separate process holds the secrets; the application asks the sidecar over a Unix socket. Couples the application to the sidecar's reliability, but isolates the vault credential to a single process.

The question to answer for each secret: which of these is in use, and which should be? A single project often has secrets coming from multiple paths because nobody designed it; the result is that some secrets are well-protected and others are pasted into env vars in startup scripts.

A specific anti-pattern: secrets baked into container images at build time. The image is portable, scannable, and copyable; the secret is now in every registry that ever pulled the image. Use runtime injection.

## Key encryption keys (KEK) and data encryption keys (DEK)

For data encryption at rest, the two-tier pattern:

- **Data encryption key (DEK).** The key actually used to encrypt the data. Per-record, per-customer, or per-table, depending on the scope. Many DEKs in the system.
- **Key encryption key (KEK).** The key used to encrypt the DEKs. Stored in the vault, rotated on a schedule, never directly used to encrypt data.

The DEK lives next to the encrypted data (typically encrypted-with-KEK and stored alongside the ciphertext). The KEK lives in the vault. Rotating the KEK is cheap — re-encrypt the DEKs, leave the data alone. Rotating a DEK is expensive — re-encrypt the data.

The reasons to use the two-tier pattern:

- KEK rotation is decoupled from data re-encryption. A monthly KEK rotation does not require touching every encrypted record.
- The vault holds a small number of keys (KEKs), not a key per record. The vault is not the bottleneck for record reads.
- If a single DEK is compromised, only that record is exposed; the rest of the data is still safe.

The naive alternative — one master key encrypting everything — means key rotation requires re-encrypting every byte. The result is that the key never rotates.

For new systems, default to envelope encryption with KEK/DEK. Most cloud KMS systems implement this for you; the application's job is to ask KMS to encrypt the DEK and store the result alongside the data.

## Breakglass design

Breakglass is the procedure for when the vault is unavailable or the on-call's normal access has been revoked. Designed badly, breakglass is either useless (nobody can recover) or a giant security hole (everyone can break into prod).

The principles:

- **Two-person rule.** Breakglass requires two humans to invoke, separately authenticated, with audit. No single human can use it alone.
- **Time-limited tokens.** Breakglass produces a credential that expires in minutes to hours, not days. After expiration, the engineer has to invoke breakglass again to continue.
- **Audit trail.** Every breakglass invocation is logged, includes the reason, and triggers a notification to a security audit channel that someone other than the invokers will see.
- **Rotation after use.** Any secret accessed via breakglass should be rotated immediately after the incident. The breakglass invocation itself counts as an exposure event.
- **Tested quarterly.** A breakglass that hasn't been exercised in a year doesn't work. Schedule a dry-run; check that the procedure still works, the people still have the right access, and the audit pipeline still alerts.

The shape of a breakglass:

- A separate, isolated credential set (not derived from the normal vault) that grants emergency access.
- Stored physically (paper in a safe) or in a different system (a separate vault, an offline HSM).
- Invocation requires the two-person ceremony — physical presence, video call with cameras, or some equivalent verification of two distinct humans.

The most common failure: the breakglass that's "in the wiki" or "in a private 1Password vault that only the CTO has". Both fail when the CTO is unreachable. Design for the cases when the people you'd normally call are unavailable.

## Secret-in-code detection

Secrets in source code are an exposure event the moment the code is committed, regardless of whether the repo is public. Git history is durable and frequently leaks (forks, backups, build artifacts).

The defense in depth:

- **Pre-commit hook.** A hook (e.g., gitleaks, detect-secrets, truffleHog) scans every commit before it lands. The bar is "block the commit"; a warning-only hook is ignored.
- **CI scan on every PR.** A secondary check in CI catches commits that bypassed the local hook. The PR is blocked until the secret is removed.
- **Periodic full-history scan.** A weekly or monthly scan of the entire repo history, including all branches. Catches secrets added before the hook was installed or via paths that bypassed the hook. For this in the openclaw context, use verified-history-scan.
- **Post-incident reaction.** When a secret is found in code, the rotation is non-optional. Do not assume "it's a private repo, we're fine"; assume the secret is compromised and rotate.

The history scan is the one that catches old surprises. Repos accumulate secrets over years; the scan finds them.

## The "secret is leaked, what now" runbook

When a leak is suspected or confirmed:

1. **Confirm the leak.** Where was it? Public repo? Logs? Customer email? Build artifact? The confirmation determines the blast radius.
2. **Rotate the secret immediately.** Do not delay for investigation. The leaked secret is potentially compromised; treat it as actively compromised. Generate a new value, update the consumers, invalidate the old one.
3. **Identify and revoke active sessions.** If the leaked secret authorized active sessions (e.g., a leaked JWT signing key signed tokens that are still valid), revoke them. Invalidate the sessions, force re-authentication.
4. **Audit access logs.** What did the leaked secret do during the exposure window? Was there unusual activity? An attacker who got the secret may have already used it; the access log tells you what they did.
5. **Notify stakeholders.** Internal: security team, incident channel, affected service owners. External: depends on the secret. A leaked customer-data-encryption key requires customer notification and likely regulatory notification.
6. **Post-mortem and prevention.** How did the secret leak? Pre-commit hook missing? CI scan failed? Was it printed to a log? File a post-mortem with action items; see post-mortem-writing.

The temptation in step 2 is to investigate before rotating. Do not. Rotate first; investigate while the new secret is taking effect. The window of exposure is the time between leak and rotation; minimize it.

The exception: if rotation itself causes a production incident (e.g., a database password rotation that requires a coordinated service restart), the rotation must still happen but on a controlled timeline. Page the on-call; coordinate the rotation as a scheduled change; do not skip it.

## Secret inventory

You cannot manage what you cannot enumerate. The inventory is the list of every secret in production, with:

- Name and purpose ("Stripe production API key", "Postgres replica admin password").
- Current location (which vault, which path).
- Owner (which team or engineer is responsible).
- Last rotated (date).
- Next rotation due (date, computed from cadence policy).
- Consumers (which services use this secret).
- Breakglass procedure if this specific secret can't be retrieved.

The inventory is itself an artifact someone owns. Drift is the default; a quarterly review forces reconciliation. Pull the actual list of secrets from the vault; compare to the inventory; flag the deltas (orphaned secrets, missing-from-inventory secrets, past-due rotations).

A vault full of secrets with nobody owning any of them is the state most teams discover during their first audit. The inventory ownership is the fix.

## Common anti-patterns

- **One vault for prod, staging, and dev.** One credential away from total compromise.
- **No rotation, ever.** "It still works." Yes, and the attacker who got it three years ago still works.
- **Secrets in env vars set by a shell script in source control.** The shell script is in the repo; the secret is in the repo.
- **Slack DM the secret.** The Slack history is the audit log for the next breach.
- **No breakglass.** "If the vault is down, we'll figure it out." You won't; the incident becomes a multi-hour outage while you reconstruct.
- **Breakglass with one human.** A single point of failure for "I locked myself out".
- **Rotation cadence undocumented.** Each engineer rotates "when it feels stale". Some never do.
- **Pre-commit hooks installed locally but not enforced.** The contributor who didn't install the hook commits the secret.
- **Post-leak investigation before rotation.** The exposure window grows while you figure out what happened.
- **KEK never rotated because rotation would require re-encrypting all data.** The encryption-at-rest design didn't anticipate rotation; the result is a key that lives forever.

## Output format

When this skill is invoked to design or audit a secrets system, structure the output as:

1. **Inventory baseline.** What secrets exist, where they live, who owns them.
2. **Vault selection.** Managed vs self-hosted, segmentation strategy.
3. **Rotation policy.** Cadence per secret type, automation plan.
4. **Runtime delivery path.** Per secret class, how it gets to the consumer.
5. **KEK/DEK design.** If data-at-rest encryption is in scope.
6. **Breakglass procedure.** Documented, two-person, time-limited, audited.
7. **Detection layer.** Pre-commit, CI, periodic history scan.
8. **Leak response runbook.** Concrete steps, ordered, with rotate-first discipline.

## Related skills

- `safe-public-release` — the release gate that scans for secrets before publishing to a public remote. Secrets management is the upstream system; safe-public-release is the last-mile check.
- `verified-history-scan` — the periodic full-history scan that catches secrets accumulated over the repo's lifetime.
- `security-review` — the broader security review where secrets handling is one chapter.
- `threat-modeling` — when designing a new system, the threat model identifies which secrets exist and what their blast radius is.
- `incident-response` — when a leak escalates to an incident, the incident playbook applies.
- `post-mortem-writing` — after a leak, the post-mortem captures the lessons and action items.
- `monitoring-and-alerting` — alerts on vault access patterns, rotation deadlines, and breakglass invocations.
