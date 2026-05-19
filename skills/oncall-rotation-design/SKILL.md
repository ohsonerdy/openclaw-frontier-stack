---
name: oncall-rotation-design
description: Use when designing or fixing an on-call rotation — schedule shape, primary/secondary structure, escalation policy, handoffs, comp, burnout signals. Triggers when the user mentions "on-call rotation", "page schedule", "follow-the-sun", "handoff ritual", "primary/secondary", "escalation policy", "first-week on-call", or "on-call burnout". The skill is about structuring the rotation so the system is operable without burning out the operators. For the playbook the on-call runs when paged, see incident-response. For the alert quality that determines whether the page was justified, see monitoring-and-alerting.
metadata:
  version: 0.1.0
---

# On-call rotation design

The on-call rotation is the durability layer on top of the system. Designed well, it produces operators who are sharp, supported, and willing to take the next shift. Designed badly, it produces burnout, attrition, and the slow erosion of operational quality — the rotation that the strongest engineers quietly leave.

This skill is for the rotation's structure, not the moment of being paged. The page-handling playbook is in incident-response; the alert design that determines whether the page should fire at all is in monitoring-and-alerting. This skill is about the human system that operates production.

## When to invoke this skill

- Bootstrapping an on-call rotation for the first time.
- Auditing an existing rotation that's producing burnout signals (people leaving the team, sick days the week after on-call, pages going unacknowledged).
- Changing the rotation shape (length, cycle, structure) and wanting to think through tradeoffs.
- Adding follow-the-sun or cross-timezone coverage.
- After a serious miss (a page that wasn't acknowledged in time, an incident that escalated because nobody picked up).
- Designing the escalation policy for a new service.

The signal you need this skill: people are leaving the rotation, or people are dreading their shifts, or the on-call is consistently catching things support could have handled, or the page-to-fix cycle is slow because the operator wasn't sharp.

## Rotation length

The choice of rotation length is the single biggest lever on burnout and operator sharpness. The options:

- **Daily / 24-hour rotation.** Each engineer is on for one day at a time. Pros: spread the load thin; no long stretches. Cons: handoff overhead is high (every day a new person reads the in-flight tickets); no time to develop context.
- **Weekly rotation.** Each engineer is on for one week. Pros: time to develop context, lower handoff overhead. Cons: a bad week is a whole bad week. Most common pattern.
- **Two-week rotation.** Each engineer is on for two weeks. Pros: even more context; cheaper handoffs amortized. Cons: even more brutal if it's a bad two weeks; reduces rotation frequency for any individual.
- **Follow-the-sun across timezones.** Multiple regions split the 24-hour clock; each region works business hours. Pros: nobody is paged at 2am. Cons: requires staffing in multiple timezones; handoff is twice a day; context loss across boundaries is real.

The right answer depends on team size and pager volume:

- **Team of 4-6, low pager volume (under 1 page/week).** Weekly is the default. Even at low volume, weekly gives enough context that the engineer knows the recent state.
- **Team of 4-6, high pager volume (multiple pages/week).** Weekly is too punishing; consider daily or split shifts. The sustained sleep deprivation is the issue.
- **Team of 8+, low pager volume.** Weekly with both primary and secondary. Each engineer is primary every 8 weeks, secondary every 8 weeks (offset).
- **Team across multiple regions.** Follow-the-sun is worth the handoff cost when the team can support it. Two regions covering 12 hours each is much kinder than weekly-24/7.

## Primary and secondary structure

A rotation with only a primary is fragile. The secondary's role is the human safety net.

- **Primary.** Receives the first page. Owns triage and mitigation. Drives the incident if one is declared.
- **Secondary.** Backup if primary doesn't respond. May be paged for incidents that need a second pair of hands. Helps with hard problems. Not just for absence — for capacity.
- **Escalation manager / staff engineer.** A third tier for incidents requiring more authority or experience. Not on a rotation; paged when the IC requests.

The "no double on-call" rule: an engineer is either primary or secondary, not both. The exception is small teams where this isn't feasible — in which case rotate the dual role aggressively (no person on both primary and secondary in the same shift).

The secondary should be paged when:

- Primary hasn't acknowledged after a defined window (3-5 minutes is typical).
- Primary is heads-down on a complex incident and needs another set of eyes.
- The incident is severe enough that one person isn't enough.
- Primary is exhausted, sick, or otherwise unavailable mid-shift.

A secondary who is never paged is paying for an insurance policy nobody uses. Two failure modes here: the actual primary failures aren't being escalated (silent failure), or the team's pager volume is so low that secondary is overkill (downgrade to a single primary with a manager-escalation fallback).

## Handoff rituals

The handoff is the moment when one engineer's working memory of the production state has to be transferred to the next. Skipping the handoff is the equivalent of starting a shift with no context.

The minimum handoff content:

- **Open incidents.** Anything currently in progress, status, what's pending.
- **Recent pages.** What fired in the last shift, what was done, any pending follow-up.
- **Deferred items.** Things the previous shift looked at and decided to handle next.
- **Scheduled work.** Any planned changes during the upcoming shift (deploys, migrations, vendor maintenance windows).
- **Watch items.** "Service X has been flaky; if it pages, do Y first." Things the next shift should know but might not see in any ticket.

A good handoff is a 10-minute synchronous conversation (or written summary in a handoff channel if synchronous isn't possible). The exchange:

- Outgoing shift: "Here's what I dealt with, here's what's open, here's what I'm watching."
- Incoming shift: "Got it; here are my questions."

Skipping handoff is a common failure mode. It feels efficient ("nothing's on fire, why bother"). The cost shows up the next time something flares and the new shift has no context.

For follow-the-sun rotations, the handoff is twice a day across regions. The discipline matters more, not less.

## Escalation policy

The escalation policy is the chain of who-gets-woken-when-and-why. Pre-authorize the chain so the on-call doesn't have to decide mid-page.

- **Primary on-call.** Pages on every fired alert.
- **Secondary.** Pages if primary hasn't acknowledged after N minutes (usually 3-5).
- **Escalation manager / lead.** Pages for Sev 1, or if the primary explicitly escalates, or if the incident has been going for over a defined duration.
- **Engineering manager / director.** Pages for Sev 1 affecting major customers, or for incidents over a defined duration, or if the on-call explicitly escalates.
- **Executive / CEO.** Pages for major customer-affecting incidents, regulatory exposure, security breaches. The on-call's IC decides; pre-authorize this in advance.

The wake-the-CEO question is real and worth pre-deciding. Some triggers: customer-affecting Sev 1 over 30 minutes, data loss or breach, regulator-reportable event. The on-call shouldn't have to weigh "is this CEO-worthy?" mid-incident.

A specific failure mode: vague escalation. "Escalate if it's bad" is not a policy. The policy is the matrix of (severity, duration, business hours) -> who gets paged. Document it; pre-authorize it; don't expect the on-call to figure it out at 3am.

## First-week on-call

A new engineer's first on-call shift is the highest-risk shift of their career. Two patterns work:

- **Shadow before solo.** The new engineer is "secondary to the secondary" for a shift or two, observing how the actual primary handles pages. No pages, no responsibility, just observation.
- **Co-pilot first solo.** When the new engineer goes primary, a senior engineer is on lower-volume backup for that week — paged secondary-style, but explicitly there to help, not to take over.

Without one of these patterns, the new engineer's first shift is also their first incident at full responsibility. The error rate spikes; the engineer's confidence cracks; the team loses a future operator.

The lookback after first solo: a debrief covers what surprised them, what wasn't documented, what tools they wished they had. The debrief findings go into the on-call documentation for the next new engineer.

## Comp and time off

The compensation question is real and varies by company. The principles:

- **On-call is work.** Even when no page fires, the engineer is constrained — can't drink, can't sleep deeply, can't travel out of cell range. That's a real cost.
- **Compensation models.** A common option: a defined per-week stipend for on-call shifts, plus per-page comp time (the next day off after a 2am page, regardless of who took the page).
- **OOO-replaces.** If an on-call engineer is OOO during their shift, someone else has to cover. Coverage swaps should be easy; "I'm out, can someone take Tuesday?" should be a Slack message, not a negotiation.
- **Heavy-shift recovery.** After a Sev 1 night, the next day is comp time. After a week of multiple pages, an extra day off. Trade rest for sustainability.
- **Long-term burnout signal: declining shift quality.** If the same engineer is acknowledging late, making more mistakes, or just hating their shift more — they're heading for burnout. Reduce their rotation frequency before they quit.

The wrong posture: "on-call is part of the job, no extra comp". This works in environments where on-call is trivially light. As soon as it's not, the strongest engineers leave first.

## Burnout signals

Watch for these patterns in the rotation:

- **Third page in four hours.** That shift is broken. The engineer is sleep-deprived and operating at reduced capacity. Page the secondary, give the primary a few hours off, debrief later.
- **Two weekend pages in a row.** That month is broken for that engineer. Adjust the upcoming rotation.
- **Sick day the week after on-call.** A recurring pattern. The engineer is recovering rather than resting. Reduce shift length or volume.
- **Acknowledgment time creeping up.** The engineer is not responding as quickly. Either they're tired or they're avoiding it. Talk to them.
- **An engineer asking to skip the rotation.** Almost always burnout. Listen, don't shame.
- **Attrition disproportionately from the on-call engineers.** The strongest engineers are leaving the rotation. The rotation itself is the issue, not their work.

Each signal triggers an intervention. Don't wait for the engineer to say "I quit" before reducing their load.

## Page volume and quality

The rotation can be perfectly designed and still produce burnout if the pages themselves are bad. Bad pages = noisy alerts, false positives, alerts on causes (not symptoms), alerts without runbooks.

If the team's page volume is high, the first move is not "rotate faster". The first move is "fix the alerts" — see monitoring-and-alerting. Most on-call burnout is actually alert-quality burnout in disguise.

Specific patterns to watch:

- Same alert firing repeatedly without root-cause resolution. The on-call is treating the same symptom every week.
- Pages that turn out to be no-action — false positives that fired anyway. Tune the alert or kill it.
- Pages without runbooks. The engineer paged at 2am has to figure it out from scratch every time. Every alert should link to a runbook.

The page-quality audit is part of the on-call retro: which pages were useful, which were noise, what should be tuned for next time.

## The post-rotation retro

After each shift (weekly cadence), a brief retro:

- **What pages fired.** Were they actionable? Were they correctly triaged?
- **What problems surfaced.** Any incidents to follow up on, post-mortems to write.
- **What was hard about the rotation.** Sleep loss, ambiguity, lack of context, missing runbooks.
- **What needs to change.** Alert tuning, runbook writing, escalation adjustment.

The retro feeds back into the system. Without it, the same problems recur shift after shift; the rotation degrades silently.

## Documentation the rotation depends on

The rotation works only if the artifacts it leans on are current. The checklist:

- **Runbook per alert.** Every paging alert links to a runbook. The runbook is precise: how to confirm the issue, what to check first, what to do next, when to escalate.
- **Service map.** Which services exist, what they depend on, who owns each. The on-call uses this to understand blast radius mid-incident.
- **Recent-change log.** Deploys, config changes, feature flag flips in the last 24-48 hours. The on-call's first question is "what changed?"; the change log is the answer.
- **Escalation directory.** Who to page for which kind of issue, with current phone numbers and time-zone notes. This drifts; review quarterly.
- **Customer impact reference.** Which customers care about which surfaces, especially the ones with contractual commitments. Helps the on-call triage severity correctly.

Each of these is itself an artifact someone has to maintain. The rotation lead owns the "is this current?" question; the team writes them.

## When a rotation is too small

A common pattern: a team of 2-3 engineers can't really sustain a rotation. Both engineers are effectively always on, just with one designated. The options:

- **Borrow.** Pair with an adjacent team's rotation for off-hours coverage; they cover your services in exchange for you covering theirs (with proper runbooks and training).
- **Limit on-call hours.** Business-hours only; no overnight paging. The system has to tolerate alerts queueing overnight. Workable for non-customer-facing systems.
- **Use a managed service.** Some operational responsibility shifts to a vendor's on-call. Common for databases, message brokers, CDNs.
- **Hire.** If the system genuinely needs 24/7 coverage and the team can't sustain it, the answer is more people, not heroics from the current team.

The path of "we'll just power through" is the path to attrition. Recognize early.

## Output format

When this skill is invoked to design or fix a rotation, structure your output as:

1. **Team and volume snapshot** — team size, current pager volume, team timezone distribution.
2. **Recommended rotation shape** — length, primary/secondary, follow-the-sun if applicable.
3. **Escalation matrix** — who gets paged when, with the timing.
4. **Handoff ritual** — synchronous or written, what content, what cadence.
5. **First-week support** — shadow or co-pilot plan for new engineers.
6. **Comp and time-off model** — per-week stipend, per-page comp time, heavy-shift recovery.
7. **Burnout monitoring** — what signals to watch, what interventions to take.
8. **Page-quality audit** — alert-tuning plan, runbook coverage.

## Common anti-patterns

- **Single primary, no secondary.** One engineer in the boat; if they're sick, asleep, or in a bad spot, the page goes unanswered.
- **No handoff ritual.** Each shift starts blind. Context loss compounds.
- **Vague escalation policy.** "Escalate if it's bad" — the on-call has to invent the chain mid-page.
- **No first-week support.** New engineer's first shift is also their first incident at full responsibility. High failure rate.
- **On-call as unpaid work.** Strongest engineers leave first. The rotation hollows out.
- **Burnout invisible until quit.** No tracking of shift quality, no intervention on patterns, until someone hands in their resignation.
- **Treating page volume as a fixed constraint.** It isn't. Bad alerts can be tuned. Most "we need to rotate faster" is really "we need to fix our alerts".
- **No retro.** Same problems recur indefinitely.
- **Coverage swaps require manager approval.** Adds friction to legitimate OOO needs. Trust the team to swap.
- **Wake-the-CEO question undecided in advance.** The on-call has to weigh it during the incident. Pre-authorize.

## Related skills

- `incident-response` — the playbook the on-call runs when paged. The rotation is the human structure; incident-response is the procedure.
- `monitoring-and-alerting` — the alert quality that determines page volume. Most on-call burnout is alert-quality burnout in disguise.
- `post-mortem-writing` — after incidents, the lessons feed into both the alert tuning and the rotation design.
- `root-cause-analysis` — repeated pages on the same cause are an on-call signal that the root cause isn't being addressed.
- `local-dev-environment` — runbooks the on-call uses to mitigate should reference the same environment shape the engineer develops in.
- `logging-discipline` — the on-call's ability to diagnose at 2am depends on the log quality from the discipline above.
