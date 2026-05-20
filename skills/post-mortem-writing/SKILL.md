---
name: post-mortem-writing
description: Use after an incident is mitigated and the RCA is done. Triggers when the user mentions "write a post-mortem", "blameless review", "incident report", "lessons learned", "after-action review", or "we need to document what happened". The post-mortem is the artifact that closes the incident loop — it captures what happened, why, and what changes prevent recurrence. For the active incident, see incident-response. For finding the cause before writing it up, see root-cause-analysis. For tracking action items across multiple sessions, use durable-task-ledger.
metadata:
  version: 0.1.0
---

# Post-mortem writing

A post-mortem is a written artifact, not a meeting. The meeting may produce input, but the deliverable is the document. Treat it that way and the work compresses; treat it as a meeting where notes happen and the document ships late or never.

Three things have to be true for a post-mortem to be worth writing:

1. **The incident is mitigated.** Don't write the post-mortem while the system is still on fire. The temptation is to start it during the incident; that produces a worse document and a worse mitigation.
2. **The RCA is complete or near-complete.** The post-mortem consumes the output of `root-cause-analysis`. If the RCA hasn't been done, you're producing fiction.
3. **The author has authority to assign action items.** A post-mortem without follow-through is theater. If the people who will own the action items aren't bought in, the post-mortem produces resentment, not change.

## When to write one

- After every Sev 1 incident, always.
- After every Sev 2 incident, default yes — only skip if the incident was a clean repeat of one with an open post-mortem already.
- After Sev 3 incidents that surface a pattern (third repeat in a quarter, or first occurrence of a class).
- After near-misses that would have been Sev 1/2 had something not intervened.
- Never for Sev 4 / false alarms.

The bar is "did we learn something worth other teams reading". Sev 1 always qualifies; below that, it's a judgment call.

## Blameless framing

Blameless means the document focuses on system conditions, not people. It does not mean "we can't say who did what". You can and should name actions taken — that's part of the timeline. What you don't do is judge those actions.

Concrete rules:

- **Name actions, not actors, in findings.** "The migration was deployed without a pool-impact review" is better than "Engineer X deployed without reviewing pool impact". The first is a system finding; the second is a personal finding.
- **Actions in the timeline can name actors.** "14:11 — on-call paged" is fine. "14:14 — first investigator (Engineer X) joins channel" is fine. The naming is procedural, not evaluative.
- **No "should have" without "the system should have helped".** If the analysis is "the engineer should have caught the bug in review", the system version is "review tooling did not surface the bug" — and that's a fixable thing.
- **No counterfactuals about individual judgment.** "If the engineer had been more careful" is not a useful finding. People are exactly as careful as they always are.

Blameless framing is a discipline because the unconscious draft drifts toward blame. Read the draft against the rules above before publishing.

## Required sections

Every post-mortem has these sections. Adapt the level of detail to the severity, but don't drop sections.

### Summary

One paragraph at the top. Audience: someone scanning a list of post-mortems for the one they need to read. Should answer: what happened, who was affected, how long, what was the cause class, what was the fix.

Do not bury the lede. Engineers reading at a glance want the executive summary first.

### Impact

What broke, who experienced it, and for how long.

- User-facing impact: which user journeys broke, what percent of users affected, what they experienced (errors, slow loads, wrong data, etc.).
- Business impact when known: transactions lost, revenue impact, SLA breached.
- Internal impact: pages, engineer hours, on-call disruption.
- Customer-visible duration: from the first user-affected timestamp to the last user-affected timestamp. Not the alert-fired timestamp; the user-affected timestamp.

Quantify when possible. "Approximately 12% of checkout sessions failed for 14 minutes" is useful. "Some users had problems for a while" is not.

### Timeline

Reproduce the timeline from the RCA. UTC timestamps, primary-source events. Don't editorialize in the timeline; the analysis goes in the next section.

A good timeline answers "when did each thing happen", not "why". Why goes below.

### Root cause and contributing factors

Two subsections:

- **Root cause(s).** One or two conditions whose absence would have prevented the incident. State specifically, with evidence.
- **Contributing factors.** Conditions that worsened the incident, delayed detection, or prolonged the response. Each one separate, each one with evidence.

If the root cause was environmental (third-party outage), the contributing factors include the resilience gaps — those are typically more actionable than the environmental cause itself.

### What went well

This is the section most teams skip. Don't.

Postmortems that only document failures produce a culture where reading post-mortems feels punitive. Calling out what worked — the alert that caught it early, the runbook that saved a 3am page, the engineer who pulled in the right person — reinforces the systems that worked.

The bar: name two to four specific things. "Detection latency was 90 seconds, well within target." "The runbook for payment service degradation worked exactly as written." "Comms cadence was maintained throughout."

### What went poorly

The mirror section. Specific findings, not vague complaints.

- **Detection.** Did we detect in a reasonable window? If not, why?
- **Response.** Was the mitigation lever obvious? Did we have a runbook? Did the right person get paged?
- **Mitigation.** Did the mitigation work first try? If not, how many attempts?
- **Comms.** Did internal updates land on cadence? Did external comms reach customers in time?

Each finding becomes either an action item or a "we accept this risk" decision. Don't list a finding you don't intend to act on.

### Action items

This is the section that determines whether the post-mortem matters.

Each action item has four required fields:

- **Owner.** A named person, not a team. Teams don't own things; people do.
- **Due date.** Real date, not "soon". If you can't commit to a date, the action item isn't ready.
- **Severity of skip.** What happens if this isn't done by the due date? "Re-evaluate at next post-mortem" is acceptable for low-severity items. "We re-trigger this incident class" is not acceptable to leave unowned.
- **The "would this have prevented it" check.** Each action item should have a one-line justification: "if this had existed six months ago, the incident would have been [prevented / shortened / better detected]". If the answer is "neither", drop the item.

Group action items by bucket from the RCA:

- **Root cause prevention.** The fixes that, if applied earlier, would have prevented the incident.
- **Contributing factor reduction.** The fixes that would have shortened or limited the incident.
- **Detection and response.** The fixes that would have alerted faster or made response easier.

If all your action items are in the third bucket, the post-mortem hasn't found the root cause. Send it back to RCA.

### Open questions

Things you don't know but want to follow up on. Items here are not action items — they're stated unknowns. "Why did the cache TTL not expire as expected during the burst" is an open question if you weren't able to confirm during RCA. Open questions get re-evaluated at the next monthly review.

## Action item discipline

The death of post-mortems is action items that don't ship.

- **Every action item has an owner before the post-mortem is published.** Not "TBD". A named person who has agreed in writing.
- **Action items go into the same tracker as feature work.** Not a separate "action items" doc that nobody reads. If your tracker doesn't support this, the action items disappear.
- **Review action item status at a regular cadence.** Monthly review meeting, or as part of weekly engineering syncs, or via an automated dashboard. The cadence matters less than the consistency.
- **Closing an action item requires evidence.** "Done" with a link to the PR or the dashboard or the config change. "Done" without evidence is a lie that compounds.
- **An action item that misses its due date triggers a re-decision.** Either bump the date with justification, or escalate. Don't let dates slide silently.

The hardest part is the last bullet. Sliding dates is the norm, and a culture that tolerates it tells everyone that action items don't matter.

## Distribution

Who reads the post-mortem and how.

- **Engineering team that owns the affected system.** Required reading. They're the most likely to spot a flaw in the analysis and the most likely to act on the items.
- **Adjacent teams.** Especially teams whose systems intersect at the trust boundary that broke. Distribute by link, not by mandatory meeting.
- **Engineering leadership.** They should see every Sev 1/2 post-mortem to track patterns across the org.
- **Customer support, if customers were affected.** They need to know what to tell customers who ask about the incident.
- **Customers, if the incident was public.** A redacted customer-facing version of the post-mortem builds trust. Lead with the impact and the changes, not the timeline.

The customer-facing version is a different document. It uses the same source material but the audience is non-technical and has different concerns. Don't just publish the internal post-mortem as the customer-facing one.

## What makes a post-mortem worth reading

A reader who didn't experience the incident should come away with:

1. A clear picture of what broke and why.
2. A genuine understanding of the contributing factors, not just the proximate cause.
3. Confidence that the action items, if executed, would prevent recurrence.
4. A model of how the system fails that they can apply to other systems they work on.

The last one is the test that distinguishes a great post-mortem from a checkbox one. The reader should learn something about how systems break in general, not just about this incident.

## Common anti-patterns

- **Writing during the incident.** Produces a worse incident and a worse document. Wait until mitigation.
- **Naming people in findings.** Always wrong. Re-read the draft and reframe.
- **Action items without owners.** Always wrong. If nobody owns it, it doesn't ship.
- **Skipping "what went well".** Builds a culture where post-mortems are punitive. Always include.
- **Action items all in the detection bucket.** Means the RCA didn't find the root cause. Send back.
- **Vague action items ("improve testing").** Always wrong. Specific or drop it.
- **Publishing without a review by someone who wasn't in the incident.** They catch assumptions the responder is blind to.
- **Treating the meeting as the deliverable.** The document is the deliverable.

## The customer-facing post-mortem

When the incident affected customers and you've committed to publishing a public post-mortem, it is a different document with different concerns:

- **Lead with the impact, in customer language.** "Some users could not complete checkout for approximately 14 minutes" beats "the payment-service health check failed".
- **Lead with what changed for the better.** What you've done since to prevent recurrence. Specific changes, not "we are reviewing our processes".
- **Honesty about cause, without internal jargon.** "A configuration change to our database introduced a query pattern that overloaded connection pools" is honest and decoded. "An ALTER TABLE with default" is too technical.
- **No internal blame, even implicit.** External readers should not be able to identify which engineer did what. The internal-only post-mortem may have more detail.
- **A clear timeline of customer-visible events.** From first impact to resolution, with the actions taken at each point.
- **An apology, where appropriate, without being excessive.** One sentence, then move on.

Don't just publish the internal post-mortem with names redacted. The audiences are different, the questions are different, the right level of detail is different.

## Tracking and follow-through

The post-mortem is the start of follow-through, not the end. Three discipline points:

- **Each action item enters the same backlog as feature work.** A separate "incident action items" doc is where they go to die. The team's normal prioritization process should include these items.
- **Review action items on a recurring cadence.** Monthly review of open action items, what shipped, what slipped, what's blocked. The cadence is what keeps the items alive.
- **Re-open the post-mortem if action items don't ship by their due date.** A missed action item is a partial post-mortem. Either ship it, or formally re-decide the priority with the team that owns it.

Teams that publish post-mortems but don't track action items have a process that produces documents and not change. The documents matter; the change is what prevents recurrence.

## Common patterns across multiple post-mortems

Reading a year of post-mortems together is sometimes more informative than reading any single one. Patterns to look for:

- **Same root cause class across multiple incidents.** A missing control that keeps surfacing through different incident shapes.
- **Action items that repeat.** "Improve testing" appearing in five post-mortems suggests the action item itself is broken, not the testing strategy.
- **Detection latency creeping up.** If alerts are taking longer to fire on real incidents, the monitoring is decaying.
- **Same systems involved repeatedly.** A service that produces frequent incidents is a candidate for deeper investment — not more post-mortems.

This aggregate review is a quarterly exercise. The individual post-mortems are detail; the aggregate is the signal about engineering health.

## Output format

When this skill is invoked, the output is a complete draft post-mortem document with the sections above filled in. If information is missing, mark the section with `[needs input: <specific question>]` rather than leaving it blank or inventing content.

Sections in order: Summary, Impact, Timeline, Root cause and contributing factors, What went well, What went poorly, Action items (by bucket), Open questions, Distribution list.

## Related skills

- `root-cause-analysis` — produces the input this skill consumes.
- `incident-response` — the live-incident playbook. Postmortem starts after.
- `durable-task-ledger` — for tracking action items across sessions when the work spans multiple owners or subagents.
- `monitoring-and-alerting` — many action items land here; the detection layer is where most learning happens.
