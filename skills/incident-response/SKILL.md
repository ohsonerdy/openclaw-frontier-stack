---
name: incident-response
description: Use when production is on fire and you need to triage, mitigate, and communicate. Triggers when the user mentions "production is down", "users are reporting errors", "we have an incident", "Sev 1", "Sev 2", "page from on-call", "alert just fired", "things are broken in prod", or "rollback now". The goal here is to stop the bleeding, preserve evidence, and run clean comms — not to find the root cause. For root cause work after mitigation, see root-cause-analysis. For writing the post-mortem afterward, see post-mortem-writing. For designing the alerts that paged you in the first place, use monitoring-and-alerting.
metadata:
  version: 0.1.0
---

# Incident response

When production is on fire, three things have to happen in parallel and one of them gets dropped if you don't name it: stop the bleeding, preserve evidence, and communicate. The mitigation work is loud and easy to remember. The other two get forgotten unless someone is assigned to them.

This skill is the operator's playbook for the first 60 minutes. After mitigation, hand off to `root-cause-analysis`. After the dust settles, hand off to `post-mortem-writing`.

## Initial assessment

Before doing anything, answer four questions:

1. **What is broken?** A specific user-facing symptom, not a metric. "Checkout returns 500 on payment submit" beats "p99 is up". If you can't state a user-facing symptom, you may be reacting to a noisy alert, not an incident.
2. **What is the blast radius?** All users, a region, a single tenant, a feature, a percentage rollout. Blast radius drives severity and drives who needs to be paged.
3. **What changed recently?** Deploy in the last 24 hours, config change, dependency update, traffic shift, third-party outage. Most production incidents trace to a change. If nothing changed on your side, look outward.
4. **Who is in the boat?** Name the incident commander, the technical responder, and the comms lead. One person can hold two roles in a small org; nobody holds all three.

If you don't have answers to (1) and (2) yet, the first action is to find out. Triaging blindly burns time.

## Severity triage matrix

Severity is not vibes; it has a definition. Pick the worst row that applies.

- **Sev 1** — Core user journey broken at significant scale, or data loss, or security breach in progress. Customers cannot transact, sign in, or access their data. Page everyone, declare publicly, comms every 15 minutes.
- **Sev 2** — Degraded core journey, or full outage of a non-core feature, or significant performance regression. Some users affected, workaround may exist. Page on-call team, declare to internal stakeholders, comms every 30–60 minutes.
- **Sev 3** — Limited-scope bug, minor feature broken, alert without confirmed user impact. Single on-call responds during business hours. No declaration required.
- **Sev 4** — Internal noise, false alarm, or known issue with workaround. Log and close.

Re-triage as you learn more. Sev 2 becomes Sev 1 if blast radius expands. Sev 1 becomes Sev 2 once mitigation is in place but root cause is unknown. State the re-triage explicitly in the incident channel so the comms cadence updates with it.

## Roles

Even a one-person incident benefits from naming the roles, because the roles compete for attention.

- **Incident commander.** Owns the incident end-to-end. Makes decisions when responders disagree. Decides when to escalate, when to declare resolved, when to call in additional help. Not necessarily the most senior engineer — the IC is the one with the clearest head.
- **Technical responder.** Does the hands-on diagnosis and mitigation. Reads logs, runs queries, ships rollbacks, restarts services. Reports findings to the IC, not directly to comms.
- **Comms lead.** Owns internal and external communication. Drafts status updates. Manages the incident channel. Pings stakeholders on the cadence the severity demands. Insulates the technical responder from "any update?" pings.

In a small team, the IC and comms lead are often the same person. Avoid letting the technical responder hold any other role — context-switching out of diagnosis to draft a status update breaks flow at the worst time.

## Mitigation order

Do these in order. Do not skip ahead.

### 1. Stop the bleeding

The goal is to reduce or eliminate user impact, not to fix the bug. Mitigation buys time. The available levers, in rough preference order:

- **Rollback.** If a recent deploy is the suspect, roll back. Rollback is reversible; an in-place hotfix is not. The decision authority for rollback should be the on-call engineer, no approval required — pre-authorize this in advance so the deploy-team-blocking question doesn't come up at 3am.
- **Feature flag off.** If the broken code is behind a flag, flip it. Faster than rollback, narrower scope.
- **Traffic shift.** Drain the bad region, fail over to the standby, reduce the canary percentage to zero.
- **Rate limit or shed load.** If the system is under traffic pressure, reject some requests cleanly. Returning 503 with a Retry-After is better than timing out.
- **Restart.** A blunt instrument that sometimes works. Note that restart often hides the cause; preserve the failing process's logs and stack dumps before restarting if at all possible.
- **Manual workaround in support.** For low-volume incidents, telling support "do X for affected users" can buy hours. Document the workaround in the incident channel so handoff is clean.

The decision authority for these levers matters. The on-call engineer should be able to rollback, flip flags, and shift traffic without seeking approval. Requiring approval at 3am to mitigate a Sev 1 is a process bug, not a safety mechanism.

### 2. Preserve evidence

Before you start changing things, capture the failure state. After mitigation, the failure state is gone and you have to debug from memory.

- Snapshot logs from the failing window. Save the query, save the output, save the timestamp.
- Capture metrics dashboards as screenshots or links with a fixed time range.
- Save the deploy log entry for the most recent change.
- If a process crashed, grab the core dump or stack trace before restarting.
- Record what you tried, in order, with timestamps. The incident channel is the natural place for this.

Evidence preservation is the bridge between mitigation and root-cause analysis. If you skip it, the RCA becomes guesswork.

### 3. Root cause comes later

After mitigation, hand off to `root-cause-analysis`. Do not try to mitigate and find the cause at the same time — the temptation is to ship the "real fix" while the user pain is fresh, but mitigation is what's reversible and quick, while a real fix shipped under pressure often introduces a second incident.

The exception: if you cannot mitigate without understanding what broke, you have to debug to mitigate. In that case, set a timebox (e.g. 15 minutes), and if you blow past it, switch to a blunter mitigation (full rollback, traffic shift away) and accept the broader user impact until you can investigate calmly.

## Comms cadence

Comms is what differentiates a well-run incident from a chaotic one. Customers do not punish you for outages nearly as much as they punish you for silence during outages.

### Internal comms

- **Sev 1.** Update the incident channel every 15 minutes, even if the update is "still investigating, no new information". Silence reads as "they don't know what's going on".
- **Sev 2.** Update every 30–60 minutes.
- **Sev 3.** Update at start and at resolution; intermediate updates as needed.

An internal update has four fields: current status (investigating / mitigated / monitoring / resolved), what we know, what we're doing next, ETA to next update.

### External comms

For customer-facing incidents, the comms lead drafts updates for the status page and any direct-customer channels. Two principles:

- **Lead with the impact, not the cause.** "Some users are unable to complete checkout" is what customers care about. "We are seeing elevated 503s from the payment service" is engineering jargon that translates to "they don't understand the problem".
- **Don't promise an ETA you can't keep.** "We are actively investigating and will update in 30 minutes" is better than "we expect this to be resolved in 1 hour" — and then it isn't, and trust evaporates.

Status page templates by severity:

- **Sev 1 initial.** "We are aware of an issue affecting [feature]. We are actively investigating. Updates every 15 minutes."
- **Sev 1 mitigated.** "We have mitigated the issue affecting [feature]. Most users should see normal behavior. We are monitoring and investigating root cause."
- **Sev 1 resolved.** "The issue affecting [feature] has been resolved. A full post-mortem will follow."

## Incident channel hygiene

One incident, one channel. Naming pattern: `inc-YYYYMMDD-shortname`. Pin the current status to the channel topic. Update the pin as status changes.

Do not split the conversation. Side threads in DMs lose information. Engineers who join the incident 20 minutes in should be able to read the channel top-to-bottom and understand state without asking.

When the incident is declared resolved, post a final summary in the channel:

- Duration (start time, end time)
- Severity (final, possibly different from initial)
- Mitigation applied
- Outstanding investigation (link to follow-up work)
- Post-mortem owner

Then archive or rename the channel. Don't reuse it for the next incident.

## Decision authority

Decisions to pre-authorize so they don't bottleneck at 3am:

- **Rollback to the previous deploy.** On-call has full authority. No approval.
- **Disable a feature flag.** On-call has full authority. No approval.
- **Drain a region or fail over.** On-call has full authority for the primary mitigation path; multi-region or cross-cloud failover may require IC sign-off.
- **Restart services.** On-call has full authority.
- **Customer-facing comms.** Comms lead drafts; IC approves the first update of each severity bump. Subsequent updates at the same severity don't need re-approval.
- **Declaring an incident to legal/security.** IC decides; if data exposure or regulatory exposure is possible, IC pages the appropriate exec immediately.

If your team requires manager approval for any of these, fix that before the next 3am page.

## When to declare end

An incident ends when:

1. The user-facing impact is gone or at expected baseline.
2. Metrics have been at baseline for a defined hold time (10–30 minutes depending on system).
3. The IC explicitly says "this incident is resolved" in the channel.

Hold time matters. Premature resolution is a common pattern: mitigation works, traffic returns, everyone declares done, then the underlying cause flares again 20 minutes later. The hold is the difference between resolved and "we got lucky".

## Common anti-patterns

- **Debugging instead of mitigating.** The technical responder gets pulled into "let me just understand what's happening". Cut this off early. Understand later; mitigate now.
- **Mitigation by hotfix.** Shipping a "real fix" under pressure during the incident. The fix has not been reviewed, tested, or rolled back-friendly. Mitigation should be a reversible action; the real fix waits.
- **Slack DMs branching off the incident channel.** Information siloed in a DM doesn't reach the new engineer who joins 20 minutes in. Always in-channel.
- **Comms updates that promise specific ETAs.** "We'll be back up in 30 minutes" — and then it isn't. Promise the next update cadence instead.
- **No declared IC.** Everyone is debugging, nobody is deciding. Pick one even if it feels ceremonial.
- **Pre-mortem theater.** Spending 10 minutes writing the post-mortem outline during the incident. Wait until mitigation; the post-mortem is for after.
- **Skipping evidence preservation.** Engineer restarts the service before grabbing the stack trace. Now the debugging information is gone.
- **Declaring resolved before the hold time.** Re-flares are common.

## Special incident types

### Data corruption / data loss

The mitigation order changes. Stop the bleeding still applies, but evidence preservation comes higher because corrupted data tends to be unrecoverable. Specific rules:

- Identify the affected data scope before any reactive query against the corrupted store. Wrong queries can spread the corruption.
- Snapshot the database state before any restorative action. Backups are your fallback.
- Coordinate with stakeholders on the restoration policy: roll back to a known-good snapshot (data loss for the window), or attempt repair in place (longer downtime, potential further damage).
- Communicate the data scope to legal / compliance early if regulated data is involved.

### Security incident

Page security on-call alongside engineering on-call. The mitigation playbook is different:

- Containment before remediation. Isolate the affected systems; do not let the attacker pivot.
- Preserve forensic evidence; this evidence may be needed for legal action or post-mortem.
- Comms are different — public comms may be restricted by legal until investigation is further along.
- Decision authority is different — security on-call may have authority that engineering does not.

The IC for a security incident is often a security engineer; the engineering on-call is in support. Know in advance who plays which role for security cases.

### Multi-incident overlap

When two incidents fire simultaneously (relatively common during cascading failures), the IC has to decide:

- Are these the same incident? Often they are — a single root cause produces multiple symptoms. Consolidate.
- If they're genuinely distinct, separate IC and channel for each. Avoid one channel trying to coordinate two.
- Watch for one incident's mitigation creating the other. A traffic shift to mitigate region-A may overload region-B.

The first move on a multi-incident page: triage which is causing which. The dependent one resolves when the root one does.

## Output format

When this skill is invoked mid-incident, structure the response as:

1. **Current severity** and reasoning (which row of the matrix).
2. **Roles** — name the IC, responder, comms lead (or note that the user is holding multiple roles).
3. **Immediate actions** — three to five concrete steps for the next 10 minutes, in order.
4. **Mitigation lever** — name the specific lever (rollback, flag off, etc.) and the rationale.
5. **Evidence to preserve** — what to capture before mitigation runs.
6. **Comms cadence** — how often to update, who to update, status page template.
7. **What NOT to do right now** — usually "don't fix the root cause yet".

## Related skills

- `root-cause-analysis` — after mitigation, the next step. Do not try to do both at the same time.
- `post-mortem-writing` — after RCA, the write-up. Owns the action items and learnings.
- `monitoring-and-alerting` — designs the alerts that paged you. If the alert was noisy or missing context, fix that here.
- `safe-public-release` — for incidents triggered by a recent release, the same gates that protect future releases.
