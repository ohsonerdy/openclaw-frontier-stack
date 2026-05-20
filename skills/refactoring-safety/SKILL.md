---
name: refactoring-safety
description: Use when refactoring existing code without introducing regressions. Triggers when the user mentions "refactor this", "clean up this code", "extract method", "rename", "restructure", "safe refactor", "characterization tests", or "I want to change this but I'm worried about breaking things". The core discipline is to pin existing behavior with tests first, then change one thing at a time. For the test-first discipline on new code, see test-driven-development. For the dependency-side of risky refactors, see dependency-upgrade-safely.
metadata:
  version: 0.1.0
---

# Refactoring safety

A refactor by definition does not change behavior. If the behavior changes, what you have is a feature change with a refactor mixed in, and that mix is where regressions hide.

The skill is to separate the two cleanly: pin the behavior with tests, refactor against those tests, ship the refactor, then make the behavior change as a separate diff. This is slower than refactor-and-fix-at-once. It's also dramatically less likely to introduce production incidents.

## When to invoke this skill

- Renaming or moving code that's used in multiple places.
- Extracting methods or modules from a tangle.
- Restructuring a class hierarchy or a module layout.
- Replacing one implementation with another (e.g. swapping ORM, swapping cache library) without changing the contract.
- "Cleaning up" code that's been called confusing.
- Any refactor on code that has incomplete test coverage.

If the code is small, recently written, has comprehensive tests, and the refactor is mechanical (auto-rename, single-file extract), the full procedure may be overkill. The procedure is for cases where you're not sure the change is safe.

## Step 1: characterization tests first

The first move is never to write the refactor. The first move is to write tests that pin down the current behavior.

A characterization test is a test that documents what the code currently does, including the bugs. The point is not "is this behavior correct" but "if I change this code, will I know whether I changed the behavior".

For each function or method you'll touch:

1. **Identify the inputs and outputs.** What goes in, what comes out, what side effects happen.
2. **Sample real or realistic inputs.** Production logs, debug traces, the test fixtures used elsewhere.
3. **Run the code, record the outputs.** Whatever it does now is the expected value.
4. **Write the test asserting that exact output.** Even if the output looks wrong, even if the side effect is weird. The point is the pin, not the correctness.

The test becomes the spec for the refactor. If the refactor breaks the test, the refactor broke behavior. If the test passes after the refactor, the refactor is behavior-preserving (within the coverage of the tests).

The hardest part of characterization testing is psychological: you'll see bugs while writing the tests. The discipline is to encode them as-is and fix them in a separate commit after the refactor lands.

### When the code has side effects

For pure functions, characterization is easy. For code with side effects (writes to DB, sends HTTP, calls another service, mutates global state), you have two choices:

- **Inject the boundary.** Pull the side effect out behind an interface. Test against a fake. This is itself a refactor; if the codebase doesn't allow this, the characterization test step is already non-trivial.
- **Snapshot the effects.** Run the code in a controlled environment, record what happens externally (calls made, payloads sent, rows written), assert on the recording. Tools like VCR (Ruby), nock (Node), recorded fixtures (Python) make this tractable.

Either way, the side effects are now part of the pin. A refactor that silently stops sending a webhook is exactly what characterization tests catch.

## Step 2: scope discipline

One refactor per commit. One refactor per PR (or per logical unit that ships together).

- **A rename** is one refactor.
- **Extracting a method** is one refactor.
- **Moving a method to another class** is one refactor.
- **Extracting and moving** is two refactors, in two commits.

The reason: when something breaks two days after the refactor lands, the fix is to revert. The smaller the refactor, the cheaper the revert. A PR that contains a rename, an extraction, and a logic change is impossible to revert cleanly; you either lose the good parts to fix the broken part, or you keep the broken part to preserve the good parts.

Reviewer cost is also lower for small refactors. A reviewer can verify one mechanical transformation; they cannot verify five at once with confidence.

The scope discipline most-violated: starting a refactor, noticing an unrelated bug, fixing it in the same PR. Resist. Open a separate PR for the bug fix. The discipline is what keeps refactors safe.

## Step 3: refactor → test → refactor loop

The loop is:

1. Make one small change.
2. Run the tests.
3. If green, the change is in.
4. If red, undo the change. Either the change broke something (start smaller) or the tests have a bug (fix the test in a separate prior commit).
5. Repeat.

This is the inner loop of refactoring. Tight loops catch errors early; long loops where you make a dozen changes and then run the tests at the end produce a debugging session, not a refactor.

For changes that span many files (rename used in 50 places, type change that propagates):

- Make the change with a tool (LSP rename, ts-morph, AST codemod).
- Verify the tool only made the intended change (`git diff` review).
- Run the tests.

Mechanical tools beat manual edits for wide-scope mechanical changes. The risk is that the tool catches some sites and misses others; the manual review is to confirm coverage.

## Step 4: "you said refactor but the test diff says behavior change"

The most common refactor failure mode: someone announces a refactor, but the change actually shifts behavior. Tests fail, and the response is to "update the tests" — which masks the regression.

Symptoms:
- Tests fail after the refactor.
- The fix is "update the test to match the new output".
- The PR description says "refactor" but the changelog entry needs to mention a behavior change.
- Reviewers find themselves asking "wait, did this change behavior on purpose?".

When this happens, the diagnosis is one of:

- **The refactor introduced a bug.** Most common. The fix is to undo, not to update tests.
- **The previous behavior was a bug, and the refactor accidentally fixed it.** Common second. The fix is still to undo the refactor first, then ship the bug fix as a separate intentional change.
- **The previous tests were testing implementation details rather than behavior.** The tests were brittle, not the refactor. Refactor the tests to be behavior-focused, in a separate prior commit, then revisit the refactor.

The discipline: don't update characterization tests to match new behavior during a refactor. If the tests are wrong, fix them in a commit before the refactor. If the behavior changed, that's a separate intentional change.

## Step 5: extract-then-move

A common pattern: you want to move code from one location to another. The naive approach is to cut from location A and paste into location B in one diff. The safer pattern:

1. **Extract.** Move the code into a separate function or module at its current location. Call sites still reference the original location. Run tests, ship if you like.
2. **Move.** In a second step, move the extracted unit to its new location. Update call sites to reference the new location. Run tests.

The extract step is reversible cheaply; the move step is reversible cheaply once you've extracted. Combined, they're a series of safe small steps.

This pattern generalizes. Many refactors that feel risky are sequences of smaller refactors stacked, and the discipline is to stack them as separate commits rather than collapsing them.

## Step 6: strangler-fig for big rewrites

When the refactor is so big it's effectively a rewrite — replacing a module entirely, swapping a major dependency, restructuring a core data model — the procedure changes.

The strangler-fig pattern:

1. **Identify the seam.** The interface between the old code and its callers.
2. **Build the new code behind the same seam.** It implements the same interface but with the new approach.
3. **Switch one caller at a time.** Each switch is a small, reversible change.
4. **Verify and stabilize.** Run both implementations side-by-side if you can (dual-read, dual-write, shadow traffic).
5. **Migrate remaining callers.** As confidence grows, speed up.
6. **Remove the old code.** Only after all callers are migrated and verified.

Each step is small and reversible. The contrast: a big-bang rewrite where the new code replaces the old in one PR, on one merge date, with one rollback boundary, is the highest-risk pattern in refactoring. Strangler-fig converts a high-risk big change into a series of low-risk small changes.

The cost: the codebase has both implementations live for the migration window. This is the right cost to pay.

## Step 7: branch-by-abstraction

Related to strangler-fig but for changes that are too coupled to migrate one caller at a time.

1. **Introduce an abstraction in front of the existing code.** A function, an interface, an injection point.
2. **Switch all callers to use the abstraction.** Behavior unchanged.
3. **Add the new implementation behind the abstraction.** Old and new both live.
4. **Toggle callers between old and new** via configuration or feature flag.
5. **Remove the old implementation when confident.**

This works when you can't gradually shift call sites (because they're too coupled) but can gradually shift behavior (because the abstraction lets you swap implementations).

## Step 8: the "is this refactor justified" filter

The cost of refactoring is real:

- Reviewer time.
- Risk of subtle regression.
- Diff noise that obscures other changes.
- Test churn.
- Mental load of holding both shapes in mind during the transition.

Not every "ugly code" is a refactor candidate. Filters:

- **Will this code change again soon?** Code that's being modified anyway is a good candidate to clean as part of the modification. Code that's stable and ugly may be fine.
- **Is the ugliness blocking the next change?** If the next feature requires understanding this module, cleanup pays for itself. If not, the cleanup is speculative.
- **Are there test gaps?** Refactoring without tests is high risk. If the choice is "add tests then refactor" or "leave alone", "leave alone" is often correct.
- **Is this on a hot path?** Refactoring hot paths is high risk. Tighter discipline, smaller steps, more rollback planning.

Avoid yak-shaving in feature PRs. A PR titled "Add export endpoint" should not also contain three unrelated refactors. Separate PRs.

## Step 9: rollback planning

Every refactor PR ships with a rollback plan. Small refactors revert via `git revert`. Larger refactors that span multiple PRs need a documented sequence:

- If we discover the refactor was wrong N days in, what's the rollback?
- Does it require reverting in dependency order?
- Is there state (data migrations, deployed code in other services) that complicates the revert?

For strangler-fig and branch-by-abstraction refactors, the rollback is to flip the toggle back. That's why those patterns exist.

For refactors that include schema changes, the rollback is more complex — see `schema-design` for migration safety.

## Common anti-patterns

- **Refactoring without tests.** The single most common cause of refactor-induced regressions.
- **Bundling refactor and behavior change.** Always separate.
- **Updating tests during a refactor to make them pass.** Either the refactor is wrong or the tests were wrong; figure out which.
- **Wide-scope mechanical refactors by hand.** Use the tooling.
- **"Just a small cleanup" in a feature PR.** Yak-shaving. Separate the cleanup.
- **Renames that touch dozens of files in one PR.** Rename can be a single refactor in scope but a huge diff in line count. Still acceptable if mechanically generated, but call it out.
- **Refactor + dep upgrade in the same PR.** Two sources of regression in one change.
- **Big-bang rewrites.** Strangler-fig instead.

## Output format

When this skill is invoked, produce:

1. **Refactor description** — what's being changed, in scope-discipline terms (one logical refactor).
2. **Behavior pin** — what tests cover the area, what gaps exist, what characterization tests need to be added before the refactor starts.
3. **Refactor sequence** — the steps, each small enough to ship and revert independently.
4. **Pattern choice** — direct edit / extract-then-move / strangler-fig / branch-by-abstraction, with justification.
5. **Rollback plan** — for each step, how to revert.
6. **What's NOT in this refactor** — explicitly call out behavior changes deferred, unrelated cleanups deferred.

## Related skills

- `test-driven-development` — TDD discipline for new code. Refactoring safety is the parallel for existing code.
- `dependency-upgrade-safely` — for refactors that ride on top of a dep upgrade.
- `architecture-decision-records` — when the refactor reflects an architectural decision worth recording.
- `performance-profiling` — when the refactor is motivated by performance, measure first.
