---
name: root-cause-analysis
description: Use when the incident is mitigated and you need to find the actual cause — not the symptom, and not "human error". Triggers when the user mentions "what caused this", "5 whys", "RCA", "root cause analysis", "fishbone", "fault tree", "why did this happen", or "we need to understand what broke before the post-mortem". This is the bridge between mitigation and post-mortem. For the in-the-moment debugging of a specific bug, see systematic-debugging. For the active incident itself, see incident-response. For writing up the result, see post-mortem-writing.
metadata:
  version: 0.1.0
---

# Root cause analysis

Root cause analysis is what you do after the incident is mitigated but before you write the post-mortem. It is not the same as debugging — debugging finds a fault in a specific piece of code. RCA finds the chain of conditions that allowed the fault to reach production and stay there long enough to cause harm.

The discipline of RCA is that "the cause" is rarely a single thing, and the framing "X caused the outage" is almost always too thin to drive useful action items. Real incidents have multiple contributing factors. The skill is decomposing those into a structure you can act on.

## When to do RCA

- After any Sev 1 or Sev 2 incident, before writing the post-mortem.
- After any near-miss that would have been Sev 1/2 if luck hadn't intervened.
- After a recurring class of Sev 3 issues that individually felt trivial but collectively suggest a pattern.

If the incident was a clean Sev 3 with an obvious one-line fix, you may not need a full RCA. The signal that you do need one: anyone in the room can't agree on what actually broke, or the proposed action items don't feel like they would have prevented the incident.

## The trap of single-cause framing

The most common RCA failure mode is settling for a single sentence that points at the most visible symptom and stopping there. "A bad config was deployed." "The database ran out of disk." "An engineer forgot to add a null check." These are not root causes. They are surface findings.

The test: would the action items derived from this statement have prevented the incident if applied six months ago? If "add a null check on field X" is the entire action item set, the answer is no — there are other null-check sites still uncovered. The real question is: why does this codebase let null checks be optional?

This is the difference between fixing the bug and fixing the conditions that produce the class of bug. RCA aims at the second.

## Method 1: 5 whys

The 5 whys is a serial decomposition. Start with the symptom and ask "why" five times. Each answer becomes the input to the next why.

The version most teams know is fast and shallow. The version that actually works has two extra constraints:

1. **Each "why" is a falsifiable claim.** Not "because the cache was overloaded" — that's vague. "Because the cache TTL was 5 seconds and a downstream service started returning 1MB payloads at 200 RPS, exceeding the cache's memory budget within 30 seconds." Specific enough that you could be wrong, and the evidence either supports it or it doesn't.
2. **Stop on the "what would have prevented this" rule.** When the answer to a "why" is something where the action item would have prevented the incident, stop. Going further past that point usually wanders into philosophy ("why didn't we have better culture") and produces unactionable items.

Example walked out:

- Symptom: Checkout returned 500s for 14 minutes.
- Why? Because the payment service was returning timeouts.
- Why? Because the payment service was waiting on a fraud-detection downstream that had stopped responding.
- Why? Because the fraud-detection service was deadlocked on a database connection pool.
- Why? Because a recent migration added a long-running query that held connections.
- Why? Because the migration was deployed without a connection-pool-impact review.

The stopping point: "no connection-pool-impact review on schema migrations" is a process gap. Action items at that level (a migration template that includes pool impact, a CI check on long-running migrations, etc.) would have prevented the incident. Going further ("why is the migration template missing that section") starts to wander.

## Method 2: fault tree analysis

5 whys assumes one chain. Many real incidents have multiple chains that interacted. A fault tree models the incident as a top-level event decomposed into AND/OR gates of contributing conditions.

When to use fault tree instead of 5 whys:

- The incident required multiple conditions to coincide (e.g. deploy + load spike + a third-party hiccup).
- The 5 whys produces a chain that feels like one branch among several.
- You're seeing the same incident pattern recur with different root chains.

Build the tree top-down:

- **Top event.** The user-facing symptom.
- **Immediate causes.** What chain of system events produced the symptom. Often an OR gate (the symptom could have happened via several paths).
- **Each immediate cause.** Decompose into the conditions that produced it. Often an AND gate (each condition was necessary).
- **Stop at fixable conditions.** Same stopping rule as 5 whys.

The result is a diagram (or an indented bullet structure) where each leaf is a condition that, if removed, would have broken the chain. Action items come from the leaves.

## Method 3: timeline reconstruction

Both 5 whys and fault tree depend on knowing what happened. Before you can ask "why", you need an ordered, accurate timeline. Often this is where RCA actually delivers value — the team learns what happened in what order, and the misconceptions surface during reconstruction.

Reconstruct from primary sources, in this priority:

1. **Logs and metrics with timestamps.** The most reliable evidence. Capture absolute times in UTC; relative-time descriptions ("about 10 minutes after") accumulate error fast.
2. **Deploy logs, config-change logs, alert firings.** What changed when. The "everything was fine until..." moment usually shows up here.
3. **Incident channel transcript.** Who said what when, what they tried, what they observed. Treat this as primary evidence, not background.
4. **Engineer memory.** Useful for filling gaps, but the least reliable source. Memories of incident sequencing are reconstructed; people remember the order they figured it out, not the order it happened.

Build a single timeline table:

| Time (UTC) | Event | Source |
|---|---|---|
| 14:02 | Deploy of v2.34 completes | deploy log |
| 14:11 | First user report in support | ticket #4421 |
| 14:14 | p99 latency alert fires | alerting system |
| 14:18 | Engineer on-call paged | pager log |

Once the timeline is locked, the why-chain starts to write itself.

## Contributing factor vs. root cause

Most incidents have one or two conditions that, if absent, would have prevented the incident — and a longer list of conditions that made the incident worse, faster, or harder to detect. Mixing these up causes RCA to produce a bag of unrelated action items.

A **root cause** is a condition whose absence would have prevented the incident.

A **contributing factor** is a condition that worsened the incident but did not cause it.

Example: the database ran out of connections because of the bad migration (root cause). The incident lasted 14 minutes instead of 4 because the alerting threshold was set too high (contributing factor). Both are worth fixing, but they go in different action-item buckets.

The discipline: every action item should be tagged "addresses root cause" or "addresses contributing factor" or "addresses detection/response". Most post-mortems are heavy on the third bucket because it's easiest to identify, and light on the first because it's hardest.

## "Human error" is not a root cause

When the chain of "why" lands on "an engineer made a mistake", you have not finished the analysis. Stop and ask: why did the system allow that mistake to reach production? Why was the mistake easy to make? What feedback signal would have caught it earlier?

The reframe:

- "Engineer pushed the wrong config" -> "The deploy system did not validate the config shape against staging".
- "Engineer forgot a null check" -> "The type system does not enforce non-nullable fields at this boundary".
- "Engineer dropped the wrong database table" -> "The destructive-action tooling does not require a second-party confirmation".

This is not absolving the engineer. It is recognizing that any engineer would have eventually made the same mistake, so the fix has to be systemic. A culture that stops at "human error" produces post-mortems that are blameless in name only and action items that don't prevent recurrence.

The exception: if the engineer was deliberately bypassing safety mechanisms (acted in bad faith), that's a different problem — a security or HR problem, not an RCA problem. RCA assumes good-faith actors.

## Hypothesis discipline

Every "why" in the chain is a hypothesis. Treat it as falsifiable:

- **State the hypothesis specifically.** "The pool ran out of connections because the migration held them" — not "the database was the problem".
- **Identify the evidence that would support or refute it.** Connection pool metrics during the incident window, the migration's actual query plan, the count of held connections at peak.
- **Look at the evidence.** Don't assume.
- **If the evidence doesn't support the hypothesis, drop it.** Don't soft-pedal it into the timeline as "may have contributed". Either it caused the chain or it didn't.

The temptation is to accept the first plausible "why" and move on. Resist it. Especially the first "why" — that's where errors compound, because subsequent "whys" build on it.

## When the cause is environmental

Sometimes the cause is genuinely outside your system: a cloud provider had a regional outage, a third-party API rate-limited you, a CDN had a routing event. The RCA should still happen — but the question shifts to "what was our blast radius and could we have reduced it?"

For environmental causes, the action items are about resilience, not prevention:

- Could we have detected the outage faster?
- Did we have a fallback path?
- Did we degrade gracefully or fail loudly?
- How long did we wait before declaring the third party at fault?

"Cloud provider had an outage" is a root cause for the immediate symptom, but "we had no fallback path" is the root cause for the duration and severity. The action items belong to the second framing.

## Common anti-patterns

- **Closing the RCA on the first plausible cause.** Almost always wrong. Keep asking.
- **Ending on "we need more tests".** True but unactionable. Which tests? At what layer? What would they catch? If the answer to those is unclear, the action item is too vague.
- **Ending on "we need more training".** Almost always a smell. Training is rarely the right control for a system-design problem.
- **Burying contributing factors in the timeline.** They need to be called out as findings, not implied.
- **One person doing the RCA in isolation.** RCA benefits from at least one other set of eyes — the technical responder is too close to the incident, the post-mortem writer is often more removed and catches assumptions.

## When the cause is multiple incidents at once

A common pattern: an incident has occurred several times in the past quarter, each time getting filed as "fixed" but reoccurring. Individual RCAs may have found local causes, but the meta-pattern is the real signal.

When you spot a class of incidents recurring:

1. **Aggregate the RCAs.** Read the previous post-mortems together, looking for shared factors.
2. **Identify the common contributing factor.** Often a control that's missing across many surfaces, or a class of bug enabled by an architectural choice.
3. **Frame the new RCA at the class level.** Not "incident X happened", but "incidents of this shape keep happening".

The action items at the class level are usually structural: a missing layer of validation, a missing guardrail in deployment, a code pattern that needs a lint rule. Per-incident fixes won't catch the class.

The signal you're in this territory: the responder says "we've seen this before" when the page comes in. That sentence is the RCA prompt.

## How RCA changes by incident type

The procedure adapts to the kind of incident:

- **Deploy-triggered.** The first hypothesis is the deploy. Often correct. The why-chain shouldn't end at "we deployed a bug" — keep going: why did the bug reach production, why didn't the staging environment catch it, why didn't the canary catch it.
- **Load-triggered.** The first hypothesis is a load shape that exceeded capacity. The why-chain looks at why capacity was set where it was, what scaling signals existed, and whether the load shape was anticipated.
- **Third-party-triggered.** The first hypothesis is external. The why-chain shifts to resilience: why didn't we degrade gracefully, why did we fail open or fail closed in the wrong direction, why didn't we detect the third-party issue faster.
- **Data-corruption-triggered.** The why-chain has to identify how the bad data was written and how it propagated. The hardest RCAs in this category are the ones where the corruption is silent — no alert fired, the data just got wrong.
- **Configuration-triggered.** A config change that wasn't reviewed the way code changes are reviewed. The why-chain ends at "config changes don't go through the same gate as code", which is a process root cause.

Pattern-matching the incident type early speeds up the analysis; the why-chain has a predictable shape per type.

## Tools that help the RCA

A handful of tooling patterns repay the investment:

- **Standardized timeline format.** A spreadsheet or a script that ingests timestamps from logs / metrics / chat and produces the timeline table. Saves time and reduces transcription errors.
- **Saved metric queries.** During RCA, the same handful of queries get re-run for each new "why". Save them so the next RCA is faster.
- **Decision log integration.** When the RCA produces a decision (accept this risk, ship that fix), it should flow into a decision tracker. Otherwise the decisions get lost between RCA and post-mortem.
- **Searchable post-mortem corpus.** When a new incident has the question "have we seen this before", a searchable corpus answers it. Tag post-mortems with the affected system, the root cause class, and the type of mitigation.

None of these are required; all of them speed up RCAs once your team is doing them regularly.

## The RCA is for learning, not for shipping

A common misconception: the RCA's purpose is to produce action items. Action items are an output, but the deeper purpose is for the team to learn how the system actually fails. If three engineers walk out of an RCA with a clearer mental model of the failure mode, that's more valuable than a list of items that may or may not ship.

The implication for facilitation: don't rush. The "what would have prevented this" stopping rule isn't just for the why-chain — it's for the whole exercise. If the team is still arguing about whether the cause was X or Y, the discussion is teaching everyone something about the system. Cutting off the discussion to "get to the action items" wastes the learning.

The other implication: the RCA writeup should preserve the reasoning, not just the conclusions. Future engineers reading the post-mortem benefit from seeing the chain that led to the root cause, not just the root cause itself.

## Output format

When this skill is invoked for an RCA, structure the output as:

1. **Timeline** — table of events with UTC timestamps and sources.
2. **Symptom** — the user-facing impact, stated specifically.
3. **Why-chain** — 5 whys decomposition OR a fault tree, depending on the incident shape.
4. **Root cause(s)** — named explicitly, one or two at most.
5. **Contributing factors** — listed separately, each with evidence.
6. **What did not cause this** — at least one hypothesis that was considered and rejected, with evidence. This is what makes the RCA trustworthy.
7. **Action items by bucket** — root-cause-prevention, contributing-factor-reduction, detection-and-response-improvement.

The output of this skill is the input to `post-mortem-writing`. Keep it complete enough that the post-mortem writer doesn't need to re-do the analysis.

## Related skills

- `incident-response` — the active-incident playbook. RCA starts after mitigation.
- `post-mortem-writing` — the blameless write-up. Owns publication and follow-through.
- `monitoring-and-alerting` — the detection layer. Many RCAs end with action items here.
- `systematic-debugging` — for the in-the-moment bug hunt that happens during the incident. RCA operates on the resolved system; systematic-debugging operates on the live failing one.
