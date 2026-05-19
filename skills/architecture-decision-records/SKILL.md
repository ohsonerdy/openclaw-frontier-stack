---
name: architecture-decision-records
description: Use when capturing a non-trivial architecture decision so future readers know why the system is the way it is. Triggers when the user mentions "write an ADR", "architecture decision record", "should I document this decision", "we're choosing between X and Y", "design decision", or asks "why did we do it this way". The bar is: would a future reader be confused without this record. For the deeper design work that produces decisions, see api-design and schema-design. For sharing the decision through review, use requesting-code-review.
metadata:
  version: 0.1.0
---

# Architecture decision records

An ADR is a short document that captures one architectural decision: what was decided, why, what alternatives were considered, and what the consequences are. It is not a design doc, an RFC, or a meeting summary. It is the durable record of a fork in the road, written so future maintainers can understand why the code looks the way it does.

The audience for an ADR is future you. Not the team that made the decision — they remember the context. Future you is the engineer who joins in eighteen months, sees a load-bearing pattern, wonders why it's not done the obvious way, and needs three sentences of context to keep from "fixing" something that isn't broken.

## When to write an ADR

The "do I need one" test has two prongs:

1. **Is the decision hard or expensive to reverse?** Changing the database flavor, the auth protocol, the service boundary, the message bus, the deployment topology — these are decisions where a reversal six months later costs weeks of work. Write the ADR.
2. **Will future readers be confused without context?** Some decisions are not expensive to reverse but are non-obvious. "Why do we use UUIDs in API responses but integer IDs in the database" is a question that comes up regularly if the reasoning isn't written down. Write the ADR.

If neither test trips, don't write an ADR. A code comment, a docstring, or a paragraph in the team handbook is enough. ADRs accumulate; an ADR registry full of decisions that didn't need one becomes noise.

The reverse failure mode: not writing an ADR when you should have. The signal is the "wait, why did we do it this way" question coming up multiple times across different engineers. The third time it surfaces, retroactively write the ADR.

## ADR vs. RFC vs. design doc

These are not the same thing:

- **RFC (request for comments).** A proposal under discussion. Has a status of "proposed" and may not be adopted. The audience is the team, the goal is to make the decision. RFCs evolve; they have comment threads, revisions, alternative branches.
- **Design doc.** A description of how something will be built. Includes implementation details, sequence diagrams, data models. Larger than an ADR; usually one design doc references multiple ADRs.
- **ADR.** The output of a decided RFC, or the durable record of a decision that didn't need a full RFC. Short, fixed once written, supersedeable.

The lifecycle: an RFC argues for a decision. Once decided, an ADR records the outcome and the RFC's discussion archive is linked from the ADR. The ADR is what gets read going forward.

## ADR template

Use the same template every time. Variation across ADRs makes them hard to scan.

```
# ADR NNNN: <title>

Status: <proposed | accepted | superseded by ADR-MMMM | deprecated>
Date: YYYY-MM-DD
Deciders: <names or roles>

## Context

<2–6 paragraphs describing the situation that required the decision.
What forces are at play? What are the constraints? What changed
recently that makes this decision necessary now?>

## Decision

<1–3 paragraphs stating the decision in declarative present-tense.
"We use Postgres for the primary store." Not "we will use" or "we
chose to use" — the decision is now, not a future plan.>

## Consequences

<What follows from this decision. Both positive and negative.
Format as bullets or paragraphs. Be honest about the negative
consequences — an ADR that only lists positives is a sales pitch,
not a record.>

## Alternatives considered

<Each alternative with one paragraph: what it was, why it was
rejected. Use the same depth for each alternative; uneven depth
suggests the analysis was thin.>

## References

<Links to RFCs, prior ADRs that this supersedes, design docs,
external articles, internal Slack threads with archive permalinks.>
```

The four required sections are Context, Decision, Consequences, Alternatives. Drop any of those and the ADR becomes hard to interpret six months later.

## Title and numbering

ADR titles should be short noun phrases that describe the decision: "Use Postgres for primary store", "Adopt OAuth 2.0 for service-to-service auth", "Single-region deployment topology for v1". Not verbs, not questions, not vague — "Database choice" is too thin to scan.

Numbering is sequential and assigned at write time, not at proposal time. ADR 0001 is the first decision recorded; ADR 0002 is the second. Numbers never recycle even if an ADR is superseded.

File naming: `docs/adr/NNNN-<kebab-title>.md`. The kebab title makes the file name searchable; the number makes the order obvious in directory listings.

## Status field

The status field is the single most useful field for a reader who finds the ADR via search. Use these exact values:

- **proposed.** Decision under discussion. Do not implement against a proposed ADR.
- **accepted.** Decision made. The codebase reflects (or will reflect) this.
- **superseded by ADR-MMMM.** This decision is no longer in force. Always link the superseding ADR; never delete the superseded one.
- **deprecated.** The decision is no longer in force but no replacement exists. Rare; usually means the system the decision applied to has been removed.

Never delete an ADR. Even superseded ADRs are part of the audit trail. Future readers need to see the evolution.

## The supersedes chain

When a decision is reversed, the new ADR uses the same template but adds a `Supersedes: ADR-NNNN` line in its header. The old ADR's status flips to `superseded by ADR-MMMM`.

The chain matters. ADR-0003 might supersede ADR-0001, which itself superseded ADR-0000. Reading the chain backwards tells the story of how the decision evolved. Don't summarize the old decision in the new one — link to it. The old ADR is still authoritative for the period when it was in force.

If the new decision substantially changes the framing, it's a new decision (new title, new ADR, supersedes the old). If the new decision is a refinement (e.g. adding a constraint, narrowing scope), it's still a new ADR because the consequences differ — but the title may be related (e.g. "Refine session timeout policy from ADR-0007").

## Writing the Context section

This is where most ADRs fail. The context section has to answer "why does this decision need to be made now, and what would happen if we didn't make it".

Three failure modes:

- **Context too short.** "We need to pick a database." That's not context. What workload? What constraints? What changed?
- **Context too long.** Six paragraphs of background that read like a design doc preamble. ADRs are short on purpose; if the context spans pages, what you have is a design doc, and the ADR should reference it.
- **Context that argues for the decision.** Don't sneak the decision into the context section. Context describes the situation; decision describes the response. Mixing them makes the alternatives section feel pre-rigged.

Good context: state the forces, the constraints, and what changed. "Our user-facing API is read-heavy and currently uses a single Postgres instance. The next deploy will increase peak traffic 4x. We need either to scale the existing database or introduce a caching layer." That's enough — the reader knows what decision is at stake.

## Writing the Decision section

State the decision in declarative present tense, as if it's already done. "We use cursor-based pagination for all list endpoints." Not "we will use", not "we have chosen to use". The present-tense framing makes the ADR readable as a description of the current state, which is what future readers want.

Include the specific choice, not the framework. "We use Redis as the cache layer, configured with LRU eviction at 8GB" is useful. "We add a caching layer" is not specific enough to be a decision.

If there are sub-decisions (e.g. "we use Redis AND we set TTL to 5 minutes AND we use the client-side library X"), choose: either make this one ADR with several decisions if they're coupled, or break it into multiple ADRs if they're separable. The test: would I want to reverse one of these without reversing the others? If yes, split.

## Writing the Consequences section

This is the section that pays the rent for the ADR. Six months later, the reader wants to know what this decision committed the team to.

Include both directions:

- **Positive consequences.** What we get from this decision. Capacity, simplicity, vendor support, alignment with existing systems.
- **Negative consequences.** What we give up, what we have to maintain, what gets harder. Costs we now incur. Constraints we now have to design around.
- **Operational consequences.** What changes for on-call, monitoring, deploys. A new database means a new backup story, a new alerting story, a new failure mode.

The negative section is where most ADRs are dishonest. Every decision has costs; pretending it doesn't makes the ADR less trustworthy. The reader who finds an ADR with only positives assumes the author was selling rather than recording.

## Writing the Alternatives section

Each alternative gets a paragraph: what it was, why it was rejected. Same depth for each — uneven depth signals the analysis was uneven.

Avoid the strawman pattern. If an alternative is mentioned only to dismiss it ("we considered using SQLite, but that doesn't scale"), the reader can't trust that the analysis of the chosen option was rigorous either. State the actual reason: "SQLite was rejected because our multi-writer pattern is fundamental to the workload, and SQLite's WAL mode does not handle our concurrency profile."

Include at least one alternative beyond "do nothing" and the chosen option. If the choice was binary or there was no real alternative, say so explicitly — that's information too.

The "do nothing" alternative is always relevant. What happens if we don't make this decision? Sometimes the answer is "nothing breaks immediately, but we accumulate tech debt"; sometimes it's "we hit a wall in three months". Stating it makes the urgency explicit.

## Common anti-patterns

- **ADR for everything.** Dilutes the registry. Reserve for decisions that meet the test above.
- **ADR with no alternatives.** Reads as foregone-conclusion. Always include at least one real alternative.
- **ADR without negative consequences.** Reads as advocacy. Always include the costs.
- **ADR for a specific implementation detail.** "We use the Express middleware pattern" is not an ADR; it's a code style decision. ADRs are for architectural choices, not local code organization.
- **ADR that nobody reads at decision time.** ADRs that ship after the implementation has shipped are records, not decisions. Better than nothing, but a process smell.
- **Updating an ADR in place.** Never. ADRs are immutable. New decision = new ADR + supersedes the old.
- **Deleting an ADR when superseded.** Never. The audit trail is the point.

## Lightweight alternative: comment + commit

For decisions that fail the "do I need an ADR" test but are still worth recording, a structured commit message or a code comment with a date and one-paragraph rationale is the lightweight alternative.

The signal that you crossed the threshold into ADR territory: the question "why is this done this way" has come up in code review, in onboarding, or in incident review. Once it crosses your awareness twice, the ADR pays for itself.

## ADR registry hygiene

Once you have more than a handful of ADRs, the registry needs its own discipline.

- **Index file.** A `docs/adr/README.md` lists every ADR by number, title, and status. Sortable by status to find what's currently in force. Auto-generated from the file headers is even better; manual indexes drift.
- **No duplicate numbers.** Sequential numbering breaks if two people propose ADRs in parallel. The first ADR to land at a given number wins; the second renumbers before merge.
- **Status accuracy.** When an ADR is superseded, its status changes. The registry needs an audit periodically — drift in status fields creates false sense of which decisions are live.
- **Discoverable.** ADRs should be findable from the surrounding code. Comments that reference relevant ADRs in load-bearing places (`// see docs/adr/0007 for the pagination model`) help future readers find the rationale before they "fix" something.

The registry is part of the architecture. A registry that's hard to navigate becomes a registry that nobody reads, and ADRs that nobody reads serve nobody.

## Templates by team maturity

Teams new to ADRs often want lighter templates; teams maturing the practice often want more rigor. A reasonable progression:

- **Starter template.** Context, Decision, Consequences. Three sections; the alternatives are implicit. Good for first 5-10 ADRs while the team gets used to the format.
- **Standard template.** The four-section template above (Context, Decision, Consequences, Alternatives). The right level for most teams.
- **Extended template.** Adds Compliance, Stakeholders, Review Date, Cost. Useful for high-stakes decisions in regulated environments. Overkill for everyday architecture.

Adopt the standard template by default. Move to extended for specific high-stakes decisions, not as the default — the extra rigor pays off when the decision matters but slows down the practice when it doesn't.

## Reading old ADRs

A practice that the team should adopt: when joining a new area of the codebase, read the relevant ADRs first. They're load-bearing context that comments and docs don't capture.

Indicators that an ADR is stale and should be revisited:

- The status is "accepted" but the decision is no longer followed by the codebase.
- Multiple recent commits or design discussions reference but contradict the ADR.
- The ADR is more than two years old and references systems that have changed substantially.
- The author of the ADR is no longer on the team and nobody currently can defend the decision.

When you spot stale ADRs, either supersede them with a new ADR documenting the current state, or annotate them with a note that they may be out of date. Leaving stale ADRs unannotated is worse than no ADRs — they actively mislead.

## Output format

When this skill is invoked to write an ADR, produce the document in the template above. If information is missing, ask once for the gaps before producing the draft — don't invent context. The output is the file content of `docs/adr/NNNN-<kebab-title>.md`.

When this skill is invoked to evaluate "do I need an ADR for this", run the test:

1. State whether the decision is hard or expensive to reverse.
2. State whether future readers will be confused without the record.
3. If neither, recommend the lightweight alternative.
4. If either, produce the draft.

## Related skills

- `api-design` — produces decisions that warrant ADRs (versioning strategy, error shape, pagination model).
- `schema-design` — produces decisions that warrant ADRs (PK choice, denormalization, migration strategy).
- `requesting-code-review` — for routing the ADR through review before publishing as accepted.
- `writing-plans` — when the decision is large enough to warrant a written plan that an ADR would summarize.
