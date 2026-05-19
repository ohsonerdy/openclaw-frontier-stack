---
name: code-review-giving
description: Use when you are the reviewer on someone else's pull request — deciding what to comment on, how to phrase the comment, and whether to approve, request changes, or leave it open. Triggers when the user mentions "review this PR", "give code review", "what should I comment on", "is this ready to merge", "approve with comments", "should I request changes", or "drive-by review". The job is to protect the codebase without burying the author. For the author's side of the same conversation, see requesting-code-review. For the broader question of whether the change is safe to ship at all, see safe-public-release.
metadata:
  version: 0.1.0
---

# Code review (giving)

Code review is the second-cheapest place to find a bug — cheaper than production, more expensive than the author's own reread. The goal of a review is not to prove you read the diff, not to enforce taste, and not to teach the author your idioms. The goal is: stop the bugs the author would not catch, surface the risks they did not see, and let everything else go.

Most bad reviews fail in one of two ways. They drown the author in nits and make the next review feel like an interrogation, or they wave through changes the reviewer didn't really read and miss the bug the team needed them to catch. This skill exists to land in the middle: catch what matters, drop what doesn't, and leave the author still wanting to send the next PR.

## When to invoke this skill

- You've been requested as reviewer on a PR and you're sitting in front of the diff.
- You're doing a drive-by review on a PR that has been open too long and is now blocking someone.
- You're the area owner being asked to weigh in on whether a change is safe to merge.
- You're deciding whether to approve, request changes, or leave the PR open without a verdict.

If you're the author trying to get reviewed faster, this is the wrong skill — see requesting-code-review.

## The severity tiers

Every comment lives at one of four levels. Naming the level (in the comment itself, with a prefix) tells the author whether they have to do something.

- **Blocking.** "This must change before merge." Reserved for: correctness bugs, security holes, missing test coverage on risky paths, breaking changes to a public contract, anything that would cause an incident. Use sparingly. Each blocking comment carries the weight of "I will not approve until this is resolved."
- **Suggestion.** "I'd do it differently, and I think it's worth the change, but I'll defer to you." The author may push back, may defer, may agree — and the PR can still merge if they disagree.
- **Nit.** "Tiny thing, take it or leave it." Naming variables, comment wording, whitespace the linter didn't catch. The author should feel zero pressure to act on a nit. If you have many nits, it usually means the linter isn't doing its job — fix the linter, not the PR.
- **Question.** "I don't understand this — can you explain?" Not an implicit request for change. Sometimes the answer is "you're right, here's a comment in the code"; sometimes it's "this is fine, here's why" and you move on.

Prefix the comment with the level: `Blocking:`, `Suggestion:`, `Nit:`, `Question:`. The prefix protects both of you — the author knows what's load-bearing, and you don't accidentally turn a stylistic preference into a merge blocker.

## What to NOT comment on

The reviewer's restraint is more important than the reviewer's eye. The list of things to actively NOT comment on:

- **Style the linter should catch.** Whitespace, quote style, import order, trailing commas. If the linter passes, drop it. If the linter doesn't enforce it, fix the linter, not this PR.
- **"I would have written it this way."** The "would I write it this way" filter is the wrong filter. The right filter is "is this code correct, safe, and maintainable". You don't have to like the code; you have to verify it works and won't break.
- **Bikeshed disagreements about naming, unless the name is actively misleading.** "User" vs "Account" vs "Member" — pick a battle here only if the codebase has an existing convention being violated.
- **Refactors that are out of scope.** If you see a tangentially-related cleanup opportunity, file a follow-up issue. Do not block this PR on it.
- **Things the author already flagged in the PR description.** If the author wrote "I know this is hacky, doing it properly in a follow-up", do not re-raise it as a comment.
- **Things three previous reviewers already raised.** Read the existing comment thread before adding yours. Piling on adds noise.

The test for whether a comment is worth making: if the author addresses it perfectly, will the merged code be meaningfully better, or will it just be slightly more to your taste? If the latter, drop it.

## The asking-vs-asserting framing

How you phrase a comment changes how it lands. Asserting reads as "I have decided this is wrong"; asking reads as "I might be missing something, help me understand."

- **Assert when you're certain and the issue is mechanical.** "This loop runs N+1 queries — pull the lookup outside." There is no ambiguity; the author will look, agree, fix.
- **Ask when the issue involves judgment, context you may lack, or a design decision.** "What happens if the request body is empty here?" The author either explains, or realizes the bug, or proposes a fix. You learn either way.
- **Ask, don't assert, about code that the author wrote for a reason you don't yet understand.** "Is there a reason this can't use the existing helper?" gives them room to explain. "This should use the existing helper" assumes they didn't think of it.

The asking framing protects you from being wrong loudly. It protects the author from being told what to do by someone with less context. It produces better discussions and faster PRs.

## Security and correctness before style

Order matters. Walk the diff in this order:

1. **Correctness.** Does this code do what it claims to? Are the edge cases covered? Does it fail safely?
2. **Security.** Is user input trusted where it shouldn't be? Are authn / authz boundaries respected? Are secrets in the right place? See security-review for the deeper checklist.
3. **Compatibility.** Does this break any contract that has external consumers — API, schema, public type? See api-deprecation for the breaking-change taxonomy.
4. **Tests.** Is the new code tested at the level it needs? For risky paths, test-driven-development (from obra/superpowers) is the bar.
5. **Maintainability.** Will the next person reading this understand it? Is the abstraction worth its complexity?
6. **Style.** Last and least.

If you start at the bottom of this list, you spend your attention budget on the cheap stuff and never get to the load-bearing review. Spend the first half of your time on (1), (2), and (3).

## The "fail open vs fail closed" question

For any error-handling path, ask: "what happens when this fails?" The two answers:

- **Fails open.** On error, the code proceeds as if the operation succeeded. Authentication that fails open lets unauthenticated users through. Authorization that fails open lets them act. This is almost always a bug.
- **Fails closed.** On error, the code halts and surfaces the failure. Sometimes the right answer; almost always the safer default when in doubt.

Look for try-blocks that swallow exceptions, default values that paper over missing data, fallback branches that assume success. Each one is a candidate for "what if the assumed-impossible thing happens".

A specific red flag: `catch (err) { /* ignore */ }` or `if (something) {} else { /* default to allow */ }`. Both are fail-open patterns. Both deserve a blocking-or-question comment.

## The drive-by review

A "drive-by" is a review you do on a PR you weren't formally requested on — because you happen to know the area, because it's been open too long, or because the author asked in chat. Drive-bys are valuable but carry hygiene rules:

- **Don't take ownership without saying so.** If you're going to leave a few suggestions and move on, say "drive-by, not blocking — original reviewer still owns approval." Otherwise the author may think you're now the reviewer and stall waiting on you.
- **Don't block on a drive-by.** Blocking comments come from the named reviewer. A drive-by reviewer raises issues, not vetoes. If you see something that has to change, raise it and escalate to the actual reviewer, don't unilaterally request changes.
- **Don't pile on after another reviewer approved.** If someone else already approved, your drive-by is information for the author and the original reviewer, not a re-litigation of the approval.

## Approve, request changes, or leave open

Three GitHub-flavored states; three different meanings.

- **Approve.** You have read the diff, you believe it's safe to merge, and any open comments are non-blocking. Approving with active blocking comments is a contradiction — either lift the block or don't approve. "Approve with comments" should mean "approve, with suggestions / nits / questions that the author can act on or not".
- **Request changes.** You have one or more blocking concerns that must be resolved before merge. Use this when correctness, security, or contract is at risk. Do not use it for "I'd prefer a different name" — that's a suggestion comment with an approval.
- **Leave open.** You've reviewed and left comments but want to see another reviewer weigh in before committing to a verdict. Useful when the change is outside your area, or when you're unsure of the right call. Do not abuse this to dodge a decision; if you can decide, decide.

The most common review anti-pattern is "request changes" used for stylistic disagreements. This is the reviewer accidentally turning a $5 disagreement into a multi-day blocking discussion. Save "request changes" for blocking-tier issues only.

## The author's blast radius

Before you start the review, ask: who reads this PR's diff, and who lives with the merged code?

- A change to a hot internal helper used by 40 callers needs scrutiny on the call sites, not just the change.
- A change to a public API surface needs version-compatibility review, not just diff review.
- A change to release-gate code or anything with a no-self-approval rule needs the second-set-of-eyes discipline.
- A change to dependency versions needs the full dependency-upgrade-safely workflow, not just an eyeball pass.

If the blast radius is bigger than the diff, you are reviewing the wrong artifact. Ask the author to surface the impact, or do the impact analysis yourself before approving.

## Time budget and triage

Reviews compete with everything else on your day. Some triage rules:

- **Two-pass model.** First pass: read the PR description, scan the diff for the load-bearing parts (logic, security, schema), check the test names. Second pass: read line-by-line for the load-bearing files; skim the boilerplate. Don't read line-by-line for files you don't have time to read line-by-line — say so in the review.
- **Declare what you reviewed.** "I read the new auth code carefully; I scanned the test fixture changes." The author and the next reviewer know what's covered and what isn't.
- **Don't approve what you didn't read.** If the diff is 4000 lines and you read 400, do not approve. Say so, request a sub-reviewer for the rest, or ask the author to split the PR.
- **Same-day for small, three-day for large.** A 50-line PR that sits in your queue for a week is unkind. A 2000-line PR that you triage on day one and finish on day three is professional. Match the response time to the size.

## The first-pass triage walk

Before reading line-by-line, scan for these in this order — most catch high-value issues without needing deep reading:

1. **The PR description.** Does it explain why, not just what? If the author can't explain why, you're reviewing a change with no anchor. Ask before reading the code.
2. **The test coverage delta.** New behavior with no new tests is a flag. Existing tests deleted with no replacement is a flag. Test changes that loosen the assertions (was equal-to, now contains) deserve a closer look.
3. **The schema or config files.** Migrations, OpenAPI, GraphQL schema, infrastructure config. These often have outsized blast radius for their line count.
4. **Anything in a security-sensitive directory.** Auth, crypto, secrets handling, billing. Even small diffs deserve careful review.
5. **The largest single file in the diff.** Often where the load-bearing logic lives. Read this one carefully.
6. **The diff size shape.** A PR that's 80% generated code and 20% logic is a 20%-of-the-diff review; a PR that's mostly hand-written deserves full attention.

A 10-minute first-pass walk catches more bugs per minute than a 60-minute line-by-line read of the whole thing.

## Talking about the code, not the author

Specific phrasings that land better:

- **"This code does X — could it do Y?"** beats "you should do Y."
- **"What happens if Z?"** beats "you forgot to handle Z."
- **"Is there a reason this can't use the existing helper?"** beats "use the existing helper."
- **"I might be missing context — why this approach over X?"** beats "X would be better."

The framing matters because the same comment can land as an instruction or as a question. The question framing invites a response; the instruction framing invites compliance or defensiveness. The first produces better code and better authors; the second produces tense PR threads.

A specific anti-pattern: "this is wrong" without explanation. The author either capitulates (and learns nothing) or pushes back (and the discussion gets adversarial). Always include the reasoning, even if it feels obvious to you.

## The follow-up vs. block decision

You will see things in the diff that aren't blocking but are worth fixing. The triage:

- **Block.** This PR cannot merge until this is fixed. Reserved for the four blocking categories (correctness, security, contract, untested risky path).
- **Fix in this PR (suggestion).** Worth fixing, can be done quickly, the author is here right now. The marginal cost of an additional commit is low.
- **Fix in a follow-up.** Worth fixing, but not now. File an issue, link it from the PR, move on. Do not let "we should clean this up" linger as an unresolved comment.
- **Drop.** Not worth fixing. Don't comment.

The bias to fix in follow-up rather than block is what keeps PRs moving. Anything that doesn't have to land now, doesn't have to land now. The PR's job is to do the thing it set out to do, not to absorb every adjacent cleanup.

## Reviewing your own AI-generated PR (or someone else's)

When the PR was drafted by an agent, the review bar is the same, but the failure modes are different. Specifically:

- **Plausibility-shaped bugs.** Agent-written code often looks reasonable and runs successfully on the happy path but breaks at edge cases the agent didn't think to test. Pay extra attention to off-by-one, empty-collection, nil-or-zero, concurrent-access, and large-input cases.
- **Stale assumptions.** Agents pattern-match on the rest of the codebase but may not know which patterns are deprecated. Verify any imported utility, base class, or convention against current practice.
- **Fabricated APIs.** An agent occasionally calls a function or imports a module that doesn't exist. Check that every external reference resolves.
- **Missing context on this codebase.** Repository-specific conventions (which directory holds which kind of code, how secrets get loaded, how to run a specific test) may not have been honored. Verify against the existing codebase.
- **Confidently wrong test names.** Tests that describe a scenario but assert something unrelated. Read the test bodies, not just the names.

The reviewer's job is the same; the gotchas just shift. Don't trust the description more than the code.

## Output format

When this skill is invoked to drive a review session, structure your output as:

1. **What you read** — the files and sections you reviewed in detail vs. skimmed.
2. **Verdict** — approve / request changes / leave open, with one-line rationale.
3. **Blocking comments** — labeled `Blocking:`, with file:line and a concrete proposed resolution.
4. **Suggestions** — labeled `Suggestion:`, with context for why and a non-blocking framing.
5. **Questions** — labeled `Question:`, where you want the author's reasoning.
6. **Nits** — bundled at the end; the author may ignore.
7. **Out of scope** — anything you noticed that should be a follow-up issue, not blocking this PR.

## Common anti-patterns

- **Drowning the author in nits.** If you have 14 nits, you have a linter problem, not a code-quality problem.
- **Approving without reading.** Especially for large or low-stakes PRs. Either read it or pass on the review.
- **Requesting changes for taste.** Saving "request changes" for genuine blocking issues protects its weight.
- **Reviewing the author, not the code.** "You always do X" lands worse than "this code does X — could it do Y?"
- **Replying-all your way through 40 comments.** Bundle comments by file or theme; let the author triage them as one batch.
- **The phantom approval.** Approving with active unresolved blocking comments. Either resolve or downgrade them.
- **Ghosting.** Starting a review, leaving five questions, then not coming back when the author replies. Close the loop.
- **Anchoring on the first thing you see.** A weird-looking line at the top of the diff sets the tone; you find more things to comment on than you would have if you'd scanned the whole diff first. Do the first-pass walk before deep reading.
- **Reviewing for completeness, not correctness.** A long list of comments looks thorough; a short list of correct comments is more useful.
- **Letting big PRs through because the diff is intimidating.** A 2000-line PR is harder to review than a 200-line PR; that's a reason to ask for a split, not a reason to wave it through.
- **Approving Friday-afternoon PRs without scrutiny.** End-of-week PRs disproportionately hide issues. The reviewer is tired; the author is tired; the on-call inherits the result. Slow down or defer.

## Related skills

- `requesting-code-review` (obra/superpowers) — the author's side. Read it once so you understand what good-author behavior looks like; review with the same expectations.
- `security-review` — the deeper security checklist when the diff touches authn, authz, user input, or secrets.
- `api-design` and `api-deprecation` — when the diff changes a public surface, the compatibility review goes deeper here.
- `safe-public-release` — for PRs that are themselves releases, the gate is more than code review.
- `dependency-upgrade-safely` — for PRs that bump dependencies, code review alone is not sufficient.
- `test-driven-development` (obra/superpowers) — the bar for "is this tested enough" on risky paths.
