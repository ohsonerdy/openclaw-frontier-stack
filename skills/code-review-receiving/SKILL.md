---
name: code-review-receiving
description: Use when you are the author of a pull request reading reviewer feedback — deciding what to address, what to push back on, when to ask for clarification, and how to close the loop. Triggers when the user mentions "responding to code review", "address PR feedback", "argue back on a review comment", "request reviewer change", "I disagree with this review", "how do I respond to this nit", or "this review is wrong". The goal is to land good changes without burning the reviewer, and to disagree productively when the reviewer is wrong. For the reviewer's side of the same conversation, see code-review-giving. For the prep that makes the PR easy to review in the first place, see requesting-code-review.
metadata:
  version: 0.1.0
---

# Code review (receiving)

When the review comments arrive, you have three jobs: address what's correct, push back on what's wrong, and close the loop on everything. The third job is the one most authors skip. A comment with no response — even a one-word acknowledgment — leaves the reviewer wondering whether you saw it, agreed, dismissed it, or are still working on it. The PR thread accumulates ambiguity, the reviewer disengages, and the next review takes longer.

This skill is for the author's side of the review conversation. The reviewer's side is in code-review-giving; the prep work before the review happens is in requesting-code-review (from obra/superpowers).

## When to invoke this skill

- A reviewer left comments on your PR and you're deciding how to respond.
- You disagree with a reviewer's comment and want to push back without escalating.
- A reviewer left a comment you don't fully understand and you're tempted to "just fix it" rather than ask.
- The reviewer is asking for changes you think are out of scope.
- You've addressed everything and you're deciding whether to ping for re-review or wait.
- The review feels unfair, nit-heavy, or off-target and you're tempted to vent.

## The every-comment-gets-a-response rule

Every comment on your PR gets a response from you. Not necessarily a code change — a response. The shapes:

- **"Good catch, fixed in <commit>."** When the comment was right and you addressed it.
- **"You're right; I'll handle this in a follow-up because <reason>."** When the comment is right but out of scope.
- **"I think this is fine because <reason>."** When you disagree, with reasoning.
- **"Can you clarify what you mean by <part>?"** When you don't understand.
- **"Done."** When it's a nit and you addressed it. Brief is fine for nits.
- **"This is intentional; <reason>."** When the reviewer flagged something you did on purpose.

What is not an acceptable response: silence. A comment without a response stays open in the reviewer's mind. The reviewer either re-raises it (annoyed) or gives up (also annoyed). Silence is the path to a slow, friction-heavy review.

The discipline: when you finish a round of code changes, sweep the comment thread and respond to every one. Resolve the ones you addressed; reply on the ones you're discussing. The PR's comment count should drop to "open discussion items" only.

## The disagreement framework

When the reviewer is wrong, push back. When the reviewer is right and you don't like it, accept. The first is your job; the second is also your job. The skill is telling them apart.

Push back when:

- The reviewer's suggestion would introduce a bug.
- The reviewer is asking for a pattern that doesn't fit this codebase's conventions.
- The reviewer is making a stylistic preference with no correctness argument.
- The reviewer is asking for scope expansion beyond what this PR commits to.
- The reviewer is asking for something that breaks the existing API.

Accept when:

- The reviewer found a real bug, edge case, or unsafe pattern.
- The reviewer's suggestion is genuinely clearer or simpler.
- The reviewer is enforcing a convention you didn't know about.
- You're tempted to push back because the change is annoying, but the change is correct.

The test: "would a third engineer reading this comment side with me or with the reviewer?" If you can't argue your side persuasively to a hypothetical neutral party, you don't actually disagree — you're just tired and don't want to do the change.

When you push back, focus on technical merits. "I think this is fine because the existing tests cover the case the reviewer is worried about" is a real argument. "I don't agree" with no follow-up is not.

## The asking-for-clarification step

Before responding to a comment, make sure you understand it. The temptation is to assume you know what the reviewer meant and respond — either by changing the code (and changing the wrong thing) or by pushing back (and arguing against a position the reviewer didn't take).

Specific times to ask before responding:

- The reviewer's comment is short and you're not sure if it's a nit, a suggestion, or a blocker.
- The reviewer references a pattern, library, or convention you don't recognize.
- The reviewer's comment seems to misread the code; you suspect they're looking at a different part.
- The reviewer is asking "what happens if X?" and you're not 100% sure if X actually happens.

Asking is faster than guessing wrong. The reviewer's clarification is usually one sentence; the wrong response to a misread comment can spiral into multiple PR turns.

A clean clarification: "I want to make sure I understand — are you asking whether <case>? If so, <answer>. Or did you mean <alternative>?"

## The "ship vs argue" tradeoff

Some battles aren't worth fighting. The reviewer wants a different variable name; you have a slight preference for yours; neither matters. Just rename it.

The rule of thumb: if the change costs you 30 seconds and the argument would cost you 30 minutes, just do the change. The argument-time-vs-change-time math is almost always in favor of the change.

This applies to:

- **Naming nits where the reviewer's name is fine.** Pick a battle here only if the rename would make the code worse.
- **Comment wording, error message phrasing, log level adjustments.** Cheap to change, expensive to debate.
- **Small refactors the reviewer wants but you don't.** If you can do it cleanly, do it.
- **Test additions for cases you think are obvious.** The reviewer thinks they're not obvious; defer to the reviewer.

This does NOT apply to:

- Changes that introduce bugs.
- Changes that violate architectural decisions you've made for stated reasons.
- Changes that expand scope beyond what this PR set out to do.
- Style changes that contradict the codebase's documented conventions.

The "ship vs argue" judgment is your own. The reviewer's preferences aren't a force of nature; you can decline them. But decline them for reasons, not for ego.

## Responding to nits

Nits are the least load-bearing comments. The reviewer should be using "nit:" prefix; if they aren't, treat any small stylistic comment as a nit by default.

Response options for nits:

- **Auto-fixed by linter.** If the nit is something the linter could enforce, suggest tightening the linter rather than fixing this PR. "I'll fix this here, but the linter should catch it — opening a separate PR to add the rule."
- **Push to author / format consensus.** If the nit is a stylistic preference and the team doesn't have a documented convention, surface it as a team-level discussion (in a separate channel, not in this PR's thread).
- **Fix it.** For 90% of nits, just fix it. The cost is low; the goodwill is high.
- **Decline.** For the rare nit where you actively disagree, "I'd prefer to leave this as-is because <reason>" is fine. Nits don't gate approval; the reviewer should not block on it.

The volume signal: if you have 14 nits, your reviewer has a linter problem. Suggest tightening the lint config rather than addressing each one individually.

## The "out of scope" pattern

When the reviewer asks for changes that are real but bigger than this PR, the move is "out of scope for this PR — filing a follow-up." Then actually file the follow-up.

The pattern:

1. Acknowledge the reviewer's point is valid.
2. State that addressing it would expand the scope beyond what this PR set out to do.
3. Propose a follow-up: file an issue with the specific change requested, link it from the PR.
4. Ask the reviewer if they're okay with this PR landing and the follow-up being a separate change.

This requires the follow-up to actually exist. "I'll do it later" without a tracked issue is a dead promise. The issue is the artifact.

The exception: if the reviewer's "out of scope" feedback is a real safety issue (a bug, a security hole, a contract break), it's in scope. The PR introduced the issue; the PR has to address it. The "follow-up" pattern is for cleanup adjacent to the PR's actual goal, not for shipping known-bad code.

## Batch fixes vs individual commits

When the reviewer leaves 10 comments, you have two options for the code changes:

- **One commit per comment.** Each commit addresses one comment. Clean for the reviewer to re-review; they can see each change in isolation.
- **One commit for all the changes.** Faster to write; harder to re-review because the diff bundles everything.

The choice depends on the reviewer's preference and the size of the changes:

- For small, straightforward fixes (typos, renames, simple refactors), one batched commit is fine.
- For changes that involve real logic adjustments, separate commits make the re-review meaningful.
- If the original PR has a clean history, preserve it; if it's already 20 commits, one more doesn't matter.
- Some teams squash on merge regardless, in which case the commit boundary is just for review hygiene.

The discipline: when you're done, make sure the commits tell a coherent story. The reviewer should be able to read the diff against their previous comments and see "what changed for which comment".

## Re-request review timing

After you've addressed feedback, when do you ping the reviewer?

- **All comments addressed, no open discussion.** Re-request immediately. The PR is back in their court.
- **Most comments addressed, some open discussion.** Re-request and note "addressed X, still discussing Y". The reviewer knows what's pending.
- **Working on a long change.** Don't re-request yet. The "in progress" state is a draft signal.

The wrong move: re-requesting before you've actually addressed everything. The reviewer comes back, sees half the comments unresolved, and either wastes time re-reviewing or pushes back to "let me know when it's ready". Both are friction.

The other wrong move: silence after addressing feedback. The reviewer doesn't know if you're done. The PR sits in their queue without urgency. Just ping.

## Responding to a review you think is unfair

Sometimes a review feels unfair: too nitpicky, too aggressive, missing context, or just off-target. The temptation is to either capitulate (do everything they asked, resentfully) or escalate (DM your manager about the reviewer).

The better path:

- **Sleep on it.** Read the review, write a private draft response, then wait 12 hours before posting. Reviews feel different in the morning.
- **Separate the comments.** Some are right, some are wrong, some are stylistic. Triage each independently. A heavy review usually has 80% legitimate feedback wrapped around 20% nitpicks; the 80% is worth addressing.
- **Push back specifically, not generally.** "I disagree with comment X because <reason>" is productive. "This review is too nitpicky" is not.
- **Escalate only after specific pushback fails.** If the reviewer keeps blocking on what you believe are stylistic preferences after you've engaged the technical argument, escalate to a third reviewer or to the area owner. Do not escalate as a first move.

The goal is not to "win" the review. It's to ship the change while preserving the relationship with the reviewer. If you win the argument and lose the relationship, the next review is going to be worse.

## When the reviewer is genuinely wrong

Sometimes the reviewer is genuinely wrong: they misread the code, they don't have the context, they're applying a pattern from a different system, or they're just incorrect about the technical claim.

The response:

- **Point to the specific code or test that contradicts their claim.** Not "no, you're wrong"; "the test at <line> covers this case; here's the assertion".
- **Offer to walk through it.** "Want to hop on a quick call?" — sometimes a 5-minute conversation resolves what would be 10 back-and-forth PR comments.
- **Ask them to clarify their concern.** "What's the specific case you're worried about?" — sometimes the reviewer realizes mid-explanation that the case doesn't apply.
- **Get a tiebreaker.** If the disagreement is genuine and you can't resolve it, bring in a third reviewer. Don't just stalemate.

The reviewer being wrong is a normal occurrence; it's not a betrayal. Treat it as a discussion to resolve, not a battle to win.

## Output format

When this skill is invoked to help respond to a review, structure your output as:

1. **Comment-by-comment triage.** For each reviewer comment: my-position (agree / disagree / clarify-first / out-of-scope), and the response shape.
2. **Code changes.** What I'll change for the agreed-with comments; whether one commit or multiple.
3. **Discussion items.** The comments where I disagree, with the technical argument I'll make.
4. **Clarification questions.** The comments I need to ask about before responding.
5. **Out-of-scope items.** The follow-ups I'll file and link.
6. **Re-request timing.** When I'll ping the reviewer back, and what state the PR will be in.

## Common anti-patterns

- **Silent dismissal.** Resolving a comment without responding. The reviewer doesn't know what happened.
- **The "fixed" sweep.** Marking every comment "fixed" without engaging substance. Especially bad if you actually disagreed and didn't say so.
- **Argument by capitulation.** Doing what the reviewer asked while resenting it. The next PR is going to be tense; the change isn't going to age well.
- **Argument by escalation.** Going to a manager before engaging the reviewer directly.
- **Reading the review once, working in silence for two days, then dumping a 40-file diff.** The reviewer has lost context; the re-review is a from-scratch read.
- **Pushing back without reasoning.** "I disagree" with no follow-up. Either you have a reason, in which case state it, or you don't, in which case do the change.
- **Litigating nits as if they were blockers.** The reviewer prefixed it "nit:"; treat it as a nit; don't spend 200 words arguing.
- **Re-requesting review before addressing everything.** The reviewer comes back to a half-done PR. Either finish or signal "in progress, not ready yet".
- **Filing the "follow-up" issue and forgetting it.** The follow-up promise has to be real; the issue has to exist; the issue has to actually get done.
- **Taking the review personally.** Reviews are about the code. If the reviewer's tone is off, that's a separate conversation, not a code argument.

## Related skills

- `code-review-giving` — the reviewer's side. Read it once so you know what a good reviewer is trying to do.
- `requesting-code-review` (obra/superpowers) — the prep work that happens before review. The better the PR, the lighter the review.
- `api-design` and `api-deprecation` — when the review touches public API surface, the contract questions go deeper.
- `safe-public-release` — when the PR is itself a release candidate, the gate goes beyond review.
- `test-driven-development` (obra/superpowers) — when the reviewer is asking for test additions, the bar for "is this tested enough" is here.
