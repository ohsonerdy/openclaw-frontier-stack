---
name: oncall-handoff-rituals
description: Use when designing or running the handoff between on-call shifts — the synchronous overlap, the handoff document, the "what to worry about next 24h" question, and the weekend / holiday treatment. Triggers when the user mentions "oncall handoff", "shift change", "follow-the-sun handoff", "what did I miss", "off-going on-call", or "weekend handoff". The skill covers the synchronous-overlap rule, the handoff document template, the weekend / holiday differences, and the "previous oncall isn't done until next oncall acknowledges" discipline. For the broader rotation design that handoffs live inside, see oncall-rotation-design. For the incident response playbook the on-call follows, see incident-response.
metadata:
  version: 0.1.0
---

# On-call handoff rituals

The handoff is the moment one engineer's working memory of the production state transfers to the next. The handoff is also the moment most context gets lost. The off-going engineer has been steeped in the week's noise — which alert is misfiring, which deploy is half-done, which customer is unhappy. The on-coming engineer is starting cold. Without a deliberate ritual, what the off-going engineer knew evaporates and the on-coming engineer rediscovers it the hard way.

The rotation design — length, structure, escalation — is in oncall-rotation-design. This skill is narrower: it's the handoff itself, the daily-or-weekly ritual that determines whether the rotation runs smoothly or hands the next engineer a mystery.

## When to invoke this skill

- Designing the handoff ritual for a new rotation.
- Fixing a handoff that's been "send a Slack message and hope" up to now.
- Running a specific handoff today and wanting to do it well.
- Diagnosing why the on-call is "always learning things they should already know".
- Designing the follow-the-sun cross-timezone handoff.
- Designing the weekend or holiday handoff that differs from a normal weekday handoff.

## The synchronous-overlap rule

The handoff should be synchronous, with 15-30 minutes of real-time overlap. Not an async Slack message. Not a written document handed off via DM. A conversation.

The reasons:

- **Tacit knowledge transfers in conversation.** "I'm watching the queue depth on service X because it's been weird since the deploy on Wednesday" is the kind of thing nobody writes in a document but every engineer carries in their head. Conversation surfaces it.
- **Questions land at the right moment.** The on-coming engineer hears something, asks "what does that mean?", gets the answer immediately. In async, the question waits 12 hours and the off-going engineer has gone off-shift.
- **Trust transfer happens in voice.** "I'm comfortable that this isn't going to fire tonight" lands differently in voice than in text. The on-coming engineer can ask "are you sure?" and the off-going engineer can either confirm or admit doubt.
- **Forces actual handoff.** A 15-minute meeting on the calendar is harder to skip than a Slack message. The ritual existing in calendar form is the forcing function.

The synchronous part is the discipline. Some teams skip it for "low-week" handoffs because nothing's on fire; this is a mistake. The boring handoff is the easy one to do well; missing the boring ones means you don't have the muscle when the hard one comes.

The exceptions where async is acceptable:

- Genuinely zero state to transfer (no open incidents, no in-flight work, no watch items). Rare; verify before assuming.
- Follow-the-sun handoff where time zones make synchronous overlap impossible. Use written document plus the next available video call as the fallback.

## The handoff document template

The conversation is the primary; a written document is the record. The document is what someone joining mid-incident can read to catch up after the off-going engineer is asleep.

The minimum content:

- **Open incidents.** Anything currently in progress: incident ID, status (investigating / mitigated / monitoring), IC, next step, ETA.
- **In-flight pages.** Pages received this shift that haven't resolved. What fired, what was done, what's pending.
- **Deferred maintenance.** Anything the off-going engineer chose not to do but the on-coming engineer should know about. "Deploy X was held; the team plans to retry on Monday."
- **Known noisy alerts.** Alerts that have been firing this shift but aren't actionable. "Alert Y fires every 3 hours; known bug in the alert config; ignore unless it changes shape."
- **Weather warnings.** Items that aren't problems yet but might become problems. "Queue depth on service X has been climbing all week; if it crosses 10,000 page someone, otherwise leave it."
- **Customer escalations.** Customers who have reached out or who have ongoing issues. Names, ticket numbers, status.
- **Scheduled work in the next shift.** Deploys, migrations, maintenance windows. Things the on-coming engineer needs to be aware of even if they aren't running them.

The document is short. Five lines per category is plenty for most shifts. If a category is empty, write "none" — explicit "none" is more useful than absence (which is ambiguous: did they not look or is there nothing?).

The document is also durable. It lives in a known location (a wiki page, a pinned channel message, the rotation's shared doc). The on-coming engineer can re-read it during their shift; the engineer joining an incident later can read it for context.

## The "what should I worry about in the next 24h" question

The single most useful handoff question, asked by the on-coming engineer of the off-going engineer:

"What should I worry about in the next 24 hours?"

The off-going engineer's answer is the consolidated state — not a recitation of every alert that fired, but the few items that are load-bearing for the immediate future. The answer might be:

- "The deploy for project X is scheduled for Tuesday afternoon. If it goes wrong, the rollback is in <runbook>. The team will be active during deploy."
- "Service Y's queue depth has been climbing; I haven't been able to find the cause. Page the secondary if it crosses 10,000."
- "Customer Z has been complaining about latency. They've been talked to but they're frustrated. If they reach out, escalate to the account manager."
- "Nothing in particular; quiet week so far."

The question forces the off-going engineer to synthesize. The detailed handoff document is the ledger; the answer to this question is the headline. Both matter.

The on-coming engineer should also ask the converse: "What surprised you this shift?" Surprises are signals — alerts that fired unexpectedly, customer escalations that came out of nowhere, services that misbehaved without prior warning. The surprise is often the precursor to the next incident.

## The weekend handoff

Weekend handoffs differ from weekday handoffs in shape and risk. The differences:

- **Volume is lighter.** Less deploy activity, less customer traffic, fewer scheduled changes. The handoff content is shorter.
- **Escalation paths are different.** Daytime contacts are unavailable. The runbook references that work Monday-Friday may not work Saturday morning. The weekend handoff must include who's actually reachable.
- **Decision authority is different.** The team's regular IC may not be reachable. The weekend on-call may need to make calls that would normally be a group decision.
- **Recovery is slower.** If something goes badly, the rest of the team isn't around to help. The weekend on-call needs to be more conservative — preferring safe mitigation (rollback, traffic shift) over investigation.

The weekend-specific handoff content:

- Who is actually available for escalation this weekend (not the regular escalation chain — the actual phone-numbers-on this weekend).
- What scheduled work is happening this weekend (often nothing; if there is anything, who's running it).
- What "weather warnings" might be more dangerous on a weekend because the recovery capacity is lower.
- Customer contracts that are weekend-sensitive (e.g., customers with SLAs that don't pause for weekends).

The weekend handoff is shorter on operational items but heavier on context — the on-coming engineer needs more situational awareness because they have fewer resources to draw on if something goes badly.

## Holiday and PTO-collision handling

Holidays compound the weekend pattern. The team is even more sparse; recovery is even slower. The handoff into a holiday weekend should:

- Identify the absolute-minimum on-call coverage and the absolute-fallback if that person becomes unavailable.
- List who is reachable in true emergencies (sometimes a separate list from the normal escalation).
- Surface any work that should be deferred until after the holiday — don't deploy on Christmas Eve, don't run migrations on the night before a long weekend.

The PTO-collision case (the on-coming on-call is taking PTO that overlaps with their shift) is the situation that breaks rotations. The fix is at the rotation level (oncall-rotation-design) but the handoff has to surface it:

- The off-going engineer should ask: "Are you actually available for the next shift?"
- If the on-coming engineer says "I'm flying tomorrow but I'll have cell signal at the airport", that's a planning failure that the handoff can flag for the rotation lead.
- A "I'll be at a wedding all Saturday but I should be back Sunday" is a coverage gap. Fix it before the handoff is accepted.

The handoff is the last moment to catch the coverage gap. Catching it after the off-going engineer is unavailable is too late.

## The "tag your successor" discipline

When an incident opens during your shift and you hand off mid-incident, tag the on-coming engineer explicitly. Don't assume they'll see the channel.

The specific pattern:

- In the incident channel, post: "Handing off to <next-oncall>. Status: <current state>. Next action: <what they should do>."
- Tag the on-coming engineer explicitly.
- Verify they acknowledge before you go off-shift.

The discipline matters because incident channels accumulate noise; the new on-call may not notice they've inherited a Sev 2 just by scanning their notifications. The explicit tag plus acknowledgment is the handshake.

The corollary: the off-going engineer doesn't go off-shift on an incident until the on-coming engineer has acknowledged. "I'm off-shift, see ya" without confirming the next person picked it up leaves the incident half-orphaned.

## The "previous oncall isn't done until next oncall acknowledges" rule

The most important rule of handoff: the off-going engineer is not done with their shift until the on-coming engineer has explicitly acknowledged the handoff. The acknowledgment is "got it, I have the context, I'm taking over."

What this means in practice:

- The off-going engineer doesn't say "shift over" until they've had the handoff conversation and the on-coming engineer has acknowledged.
- If the on-coming engineer doesn't show up for the handoff (overslept, in a meeting, traveling), the off-going engineer is still on the hook. Their successor isn't ready; the rotation hasn't transferred.
- The handoff is mutual. The off-going engineer's job is to give the context; the on-coming engineer's job is to receive it. Either side can stop the handoff if the context isn't transferring.

This rule exists because the in-between state is the most dangerous. The off-going engineer thinks they're off; the on-coming engineer thinks they haven't started; an incident fires; nobody acknowledges. The rule prevents the gap.

The acknowledgment can be brief. "Got it; I have everything I need; thanks." But it has to happen.

## Follow-the-sun handoffs

In follow-the-sun rotations, the handoff happens twice a day across time zones. The discipline matters more, not less, because:

- The off-going engineer has been awake while the on-coming engineer has been asleep. The context gap is bigger.
- The languages and tools may differ slightly across regions; the handoff must bridge any local conventions.
- The synchronous overlap window is typically 1-2 hours total per day across two boundaries. The handoff has to be tight to fit.

The specific patterns:

- **Written-first, verbal-second.** The off-going engineer writes the handoff document during their shift (continuous update, not last-minute summary). The synchronous call covers questions and tacit knowledge.
- **Standardized templates.** The handoff document follows the same shape every time so the on-coming engineer knows where to find what they need.
- **Async fallback for time-zone misalignment.** If the synchronous overlap is genuinely impossible, the written handoff plus an explicit "I'll be reachable via Slack until <time>" gives the on-coming engineer a window to ask follow-ups.

The follow-the-sun handoff has higher overhead than a single-region handoff because the time zones are working against the synchronous discipline. Accept the overhead; the alternative is silent context loss.

## What surprised you?

The two-question version of the handoff:

1. "What should I worry about in the next 24h?"
2. "What surprised you this shift?"

The first is the consolidated state. The second is the precursor to next week's incident. Surprises are the canaries — alerts that fired unexpectedly, services that misbehaved without prior warning, customer feedback that came out of left field. The surprise is often the precursor to a real problem the system hasn't articulated yet.

The on-coming engineer should write down the surprises. The pattern across shifts (the same surprise recurring) is the signal that something deserves attention.

## Common anti-patterns

- **Async-only handoff.** Slack message at the start of the shift, no conversation. Context loss compounds.
- **No handoff because "it's a quiet week".** Quiet weeks are the practice runs. Skip the quiet handoff and you don't have the muscle for the busy handoff.
- **Handoff document filled in 90 seconds.** "Nothing to report" with no actual review. The off-going engineer didn't reflect; the document has zero value.
- **Off-going engineer goes off-shift before the on-coming engineer acknowledges.** Gap state.
- **Incident handoff with no explicit tag.** The on-coming engineer doesn't realize they've inherited a Sev 2.
- **Weekend handoff identical to weekday.** Weekend recovery capacity is lower; the handoff should reflect that.
- **Holiday handoff in the email signature.** "Heading out, ping the team if you need anything." Not a handoff; not a coverage plan.
- **PTO collision discovered after the off-going engineer is unavailable.** Should have been caught at the previous handoff.
- **Surprise question not asked.** The next incident's precursor is in the off-going engineer's head; it stays there.
- **Document and conversation cover the same ground.** Either the document is shallow (because the conversation covers everything) or the conversation is redundant (because the document covers everything). They should complement.

## Output format

When this skill is invoked to design or run a handoff, structure your output as:

1. **Synchronous overlap.** 15-30 minute window; calendar-scheduled.
2. **Handoff document.** Categories: open incidents, in-flight pages, deferred maintenance, noisy alerts, weather warnings, customer escalations, scheduled work.
3. **The two questions.** "What should I worry about?" and "What surprised you?"
4. **Weekend / holiday adjustments.** Escalation paths, decision authority, scheduled work deferral.
5. **Mid-incident handoff procedure.** Explicit tag, acknowledgment, no off-shift until confirmed.
6. **Follow-the-sun adjustments.** Written-first, standardized templates, async fallback window.
7. **Ack rule.** Off-going engineer doesn't leave until on-coming acknowledges.

## Related skills

- `oncall-rotation-design` — the broader rotation that handoffs live inside. Handoff is the daily ritual; rotation design is the structural choice.
- `incident-response` — the playbook the on-call runs when paged. Handoff includes "incident in flight, here's the state".
- `monitoring-and-alerting` — handoff often includes "alert X is misfiring; ignore until the fix lands". The alerts feed the handoff content.
- `post-mortem-writing` — handoff items often surface in post-mortems ("the new on-call didn't know about X, see how it propagated"). The post-mortem fixes the handoff process for next time.
- `disaster-recovery-exercise-design` — DR drills sometimes straddle shift boundaries; the handoff has to include "drill in progress".
- `postdeploy-verification` — the off-going engineer often hands off a deploy that's in the verification window; the on-coming engineer continues the watch.
