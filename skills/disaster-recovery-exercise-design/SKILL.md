---
name: disaster-recovery-exercise-design
description: Use when designing, scheduling, or running a disaster recovery exercise — tabletops, live drills, chaos engineering, GameDays. Triggers when the user mentions "DR drill", "disaster recovery exercise", "tabletop", "chaos engineering", "GameDay", "region failover drill", "we should test our DR plan", or "what would happen if we lost X". The skill covers tabletop vs live tradeoffs, failure modes to drill, blast radius framing, RTO/RPO validation, follow-up discipline, and the chaos-vs-DR distinction. For the underlying backup-restore system the drills validate, see backup-and-restore. For the incident response that DR exercises rehearse, see incident-response.
metadata:
  version: 0.1.0
---

# Disaster recovery exercise design

A disaster recovery plan that has never been exercised is a hypothesis. The first time you find out whether it works is during the actual disaster, which is the worst possible test environment. The discipline of DR exercises is to surface the failures of the plan while the plan is reversible and the engineers are awake.

The hard truth: every drill surfaces something broken. The plan said the failover takes 5 minutes; the actual failover takes 40. The runbook references a credential that was rotated last year. The on-call's pager wasn't configured for the secondary region. The drill that finds none of these problems is the drill that wasn't real enough.

This skill is the design and operation of these exercises. The underlying backup and restore system they validate is in backup-and-restore. The incident response playbook they rehearse is in incident-response. The post-mortems that capture what was learned are in post-mortem-writing.

## When to invoke this skill

- Designing the first DR exercise for a team or service.
- Scheduling the quarterly cadence.
- Picking which failure mode to drill next.
- Deciding whether to run a tabletop or a live exercise.
- Designing a chaos engineering experiment.
- Reviewing the action items from a recent drill.
- After an actual incident, deciding whether a drill would have caught it.
- Auditing whether the existing DR plan is current (drift is the default).

## Tabletop vs live exercise

The two formats serve different purposes.

A **tabletop** is a guided discussion. The facilitator describes a scenario ("the primary database region went down at 3am"). The participants walk through what they would do, step by step. Nothing actually breaks. The output is a series of "we would call X" and "the runbook says Y" statements.

A **live exercise** actually breaks something. A region is failed over, a database is restored from backup, a service is taken offline. The engineers respond in real time, against real infrastructure. The output is what actually happened, including all the gaps between plan and reality.

The tradeoffs:

- **Cost.** Tabletop is a 2-hour meeting; live exercise can be a multi-day effort with on-call coverage and recovery cleanup.
- **Realism.** Tabletop tests the plan as documented; live exercise tests the system as it actually is. Live exercises find bugs tabletops can't.
- **Risk.** Tabletop is risk-free; live exercises can cause real outages if the recovery doesn't work as expected.
- **Frequency.** Tabletops can run monthly; live exercises typically run quarterly or per-major-change.

The sequencing pattern that works: tabletop first to surface the obvious gaps and update the runbook, then live exercise to validate the now-corrected plan. Tabletops without follow-up live exercises become theater; live exercises without tabletop preparation are needlessly risky.

The escalation: tabletop -> partial live (in staging or with limited blast radius) -> full live (in production with real load). New systems start at tabletop; mature systems run full live periodically.

## Failure modes to drill

Pick the failure modes based on (a) probability and (b) blast radius. The high-value drills:

- **Single region outage.** The most common cloud failure. Drill the failover to the secondary region, including DNS / load balancer cutover and replica promotion.
- **Primary database loss.** The blast-radius-maximum drill. Restore from backup; validate that the restore time matches RTO; validate that the restored data matches RPO.
- **Identity provider down.** Auth0, Okta, the IAM service. Drill the breakglass auth path; verify the on-call can actually log in when the normal auth flow is broken.
- **Code-deploy bricks prod.** A deploy goes out that's broken in a way that's not immediately obvious. Drill the rollback path; verify the rollback works end-to-end including any non-code state.
- **Accidental destructive operation.** A DROP TABLE, an `rm -rf`, a delete-all-customers operation. Drill the restore path for the specific data type; verify the time to restore.
- **Third-party SaaS outage.** Stripe, SendGrid, Twilio, your payment processor, your email vendor. Drill the degraded-mode behavior; verify the system fails closed (or at least gracefully) when the dependency is unavailable.
- **Certificate expiration.** TLS certs expiring on the wrong day; the cert renewal service that quietly stopped working three months ago. Drill the manual renewal path.
- **DNS outage.** Your DNS provider goes down or you push a bad record. Drill the recovery path; verify the TTLs allow recovery within RTO.
- **Cascading dependency failure.** Service A depends on B depends on C; C goes down; the failure ripples. Drill the circuit-breaking and fallback behavior.

Don't drill all of these at once; pick one per quarter. The cadence is fewer-deeper-drills, not more-shallower.

## The blast radius framing

Different drills have different blast radii. The framing question: "if this drill goes badly, what's the worst case?"

- **Tabletop.** Zero blast radius. Talk only.
- **Live drill in staging or pre-prod.** Limited blast radius. Real systems but no customer traffic.
- **Live drill in production with limited scope.** Bounded blast radius. One service, one region, one tenant — small enough that recovery is fast if the drill goes worse than expected.
- **Live drill in production with full scope.** Full blast radius. The whole system, all traffic. Reserved for the most mature DR systems and the most important drills.

The progression: a team's first live DR exercise should not be production-wide. Start with staging, work up to a contained production scenario, work up to production-wide for the highest-priority drills only after the contained drills are clean.

Specific rules for production drills:

- **Customer notification.** If the drill might affect customers, notify in advance. Status page, in-app notice, customer email. The drill is for your team's benefit, not your customers'.
- **Off-peak timing.** Run during the lowest-traffic window. Same logic as migration timing.
- **Abort criteria.** Define in advance: if the drill is causing more user impact than expected, abort. The IC has authority.
- **Recovery validation.** After the drill, verify recovery actually worked. Metrics return to baseline, no orphaned state, no broken queues.

## RTO and RPO validation

The drill's success criterion is not "the failover worked"; it's "the failover met RTO and RPO".

- **RTO (recovery time objective).** How long the system was down. Measured from outage start (or drill trigger) to recovery complete. The plan says X; the drill measures actual.
- **RPO (recovery point objective).** How much data was lost. Measured by the gap between the last replicated write and the recovery point.

The gap between target and actual is the value of the drill. If RTO target is 15 minutes and actual is 47 minutes, that's the action item. If RPO target is 5 minutes and actual is 0 (because replication was synchronous), you over-engineered — that's also useful information.

Don't measure these by self-report. Use the actual timestamps: when the drill started (incident channel timestamp), when the system was confirmed recovered (synthetic check passed). The honest number is the timestamp, not the engineer's recollection.

## Runbook reality test

The drill exposes whether the runbook actually works. The specific failures to watch for:

- **Outdated commands.** The runbook references a tool that's been renamed or a path that's changed. Engineers improvise; the improvisation is not in the runbook.
- **Missing credentials.** The runbook says "run this command", but the command requires credentials the on-call doesn't have at 3am.
- **Stale references.** "Page the storage team" — the storage team disbanded last quarter; the team that owns the storage now is named differently.
- **Untested assumptions.** "Failover takes 5 minutes" — assertion was true when the runbook was written, no longer true after the dataset grew.
- **Hidden manual steps.** The runbook implies automation; in practice, three manual steps in the middle that aren't documented.

After the drill, the runbook update is the most important follow-up. Every gap found during the drill is a runbook fix. If you don't update the runbook, the next drill (and the next real incident) finds the same gaps.

## On-call pager validation

The drill is the natural moment to test the paging path. The on-call's pager fires at 3am — does the on-call receive it? Do they have the right access on their phone? Does the escalation work if they don't acknowledge?

The drill mode: start the drill without warning the on-call. The on-call's response is the test. If the on-call doesn't get paged, that's the most important finding of the drill, because it means real Sev 1 incidents may not be paging either.

The ethical wrinkle: don't surprise-page someone who didn't consent to drill mode. The team should know that drills happen unannounced from time to time; the specific timing isn't pre-announced. The on-call is in the rotation; they're being paid to be on-call; the drill is part of the job.

The variant: announced drills where the on-call knows it's a drill. Less realistic but easier to schedule. Use this for the team's first few drills; transition to unannounced as the team matures.

## The "no perfect drill" rule

Every drill surfaces something. That IS the success. If a drill finishes with "everything worked perfectly", either the drill wasn't real enough or the team didn't look hard enough at the gaps.

Common positives that hide real problems:

- "We hit RTO" — but the engineers had to improvise multiple steps not in the runbook.
- "The data was preserved" — but the recovery used a backup that's been failing silently for weeks.
- "The on-call responded quickly" — but only because they happened to be at their desk.

The drill report should include the unstated improvisations, the close calls, and the "we got lucky" moments. The drill is not a pass/fail test; it's an evidence-gathering exercise. The evidence is what gets you to a better system.

## Follow-up discipline

The drill produces action items. The drill is wasted unless the action items get done.

The discipline:

- **Every gap gets an action item with an owner and a deadline.** "Update the runbook" with no owner is not an action item; it's a wish.
- **Action items go on the team's regular work tracker.** Not in a one-off DR drill report doc that gets archived and forgotten.
- **Closed action items are verified.** "I updated the runbook" requires verification; the next drill should confirm the update worked.
- **Open action items block the next drill.** Don't run a new drill when the previous drill's action items are still open. The next drill will surface the same issues; you're spending real engineer time to learn the same lesson.

The most common DR program failure: drills run quarterly, action items pile up unattended, the next drill surfaces the same issues plus new ones. The drill is a forcing function for fixes, not a separate workstream.

## Cadence

Quarterly minimum for live exercises. Monthly for tabletops, if the team has the bandwidth. Per-major-change for any change to a system that materially affects DR (new service tier, new region, new dependency).

The cadence depends on:

- **System maturity.** A new DR plan needs more frequent drills; a stable one needs less.
- **System change rate.** A system being actively built needs more drills; a stable one needs less.
- **Drill quality.** If recent drills are surfacing many issues, run more drills until the rate drops; the system isn't where you thought.
- **Team change rate.** New on-call engineers need drill exposure; a team with high turnover needs more drills than a stable one.

The signal you're under-drilling: real incidents surface issues that a drill should have caught. The signal you're over-drilling: the drills are running clean for two cycles in a row and not finding anything.

## Chaos engineering vs DR exercise

The two are related but distinct.

**Chaos engineering** is the continuous practice of breaking small things in production to verify the system handles them. Run by automation (Chaos Monkey, Gremlin, custom tooling). Daily or weekly cadence. Tests the system's resilience under conditions like "this one pod just got killed" or "the latency to this dependency just spiked".

**DR exercise** is the discrete practice of simulating large-scale failure scenarios. Run by humans with planning. Quarterly cadence. Tests the system's recovery from conditions like "the primary region is down" or "the database has been corrupted".

The two are complementary. Chaos verifies the small-scale resilience; DR verifies the large-scale recovery. A team that only does chaos may never test its real DR plan; a team that only does DR exercises may have a brittle system underneath that breaks under small disturbances.

The order: chaos engineering before DR exercises if you're building from scratch. Resilience under small failures is the precondition for graceful recovery from large ones.

## Common anti-patterns

- **Drill on paper, never in practice.** Tabletop forever; the plan stays unvalidated.
- **Drill announced weeks in advance.** Everyone preps; the drill measures the prep, not the system.
- **Drill that ends at "we ran the runbook".** No measurement of RTO, RPO, or runbook accuracy. No data; no learning.
- **Drill report filed away.** Action items not tracked; not fixed; surface again in the next drill.
- **Single drill per year.** The system drifts faster than annual drilling catches.
- **Production drill without abort criteria.** When the drill goes worse than expected, the team has no defined off-ramp.
- **Production drill without customer notification.** Customers experience an outage; team narrative is "it was a drill"; customers don't care.
- **Pager test that always pages a known address.** Verifies the wire is connected, not the human response.
- **Drill that runs the system back to baseline before measuring.** The "did it work?" question is answered from the runbook, not from the metrics.
- **Same drill scenario every quarter.** Drills the same things; never tests the rare-but-catastrophic scenarios.
- **Surprise drill on a Friday at 5pm.** The team's recovery capacity is lowest; the drill becomes an actual incident.

## Output format

When this skill is invoked to design or run a DR exercise, structure your output as:

1. **Scenario.** What failure is being simulated; why this one this time.
2. **Format.** Tabletop, partial live, or full live.
3. **Blast radius.** What's at risk; the abort criteria; customer notification plan.
4. **Participants.** Who's involved; who's IC; who's observing.
5. **Success criteria.** RTO target, RPO target, runbook accuracy, paging path.
6. **Timing.** When; how long; what's the off-peak window.
7. **Data collection.** What to measure during the drill (timestamps, errors, manual steps).
8. **Action item plan.** How gaps will be tracked and verified.

## Related skills

- `backup-and-restore` — the underlying system the drills validate. The drill is the test of the backup; backup-and-restore is the system being tested.
- `incident-response` — the playbook the drill rehearses. The drill is practice for the playbook.
- `monitoring-and-alerting` — alerts that signal during a drill (and that may need tuning when the drill exposes a gap).
- `post-mortem-writing` — the format for capturing what was learned from a drill.
- `oncall-rotation-design` — drills are a load on the rotation; build the cadence into the rotation expectations.
- `oncall-handoff-rituals` — drills often happen at shift boundaries; the handoff should include "drill in progress" if applicable.
- `postdeploy-verification` — many drills test rollback paths; postdeploy verification provides the trigger signal.
