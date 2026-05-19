---
name: dependency-upgrade-safely
description: Use when upgrading npm/cargo/pip/maven/Go module/etc. dependencies without breaking production. Triggers when the user mentions "upgrade dependencies", "bump version", "npm update", "Dependabot PR", "security patch", "renovate", "is this safe to merge", or "should I take this update". The output is a defensible upgrade plan that catches the actual risks rather than rubber-stamping. For the security side of risky deps, see security-review. For the refactoring that may be needed when a major version lands, see refactoring-safety.
metadata:
  version: 0.1.0
---

# Dependency upgrade safely

The safest dependency upgrade is the one you understand. The riskiest is the one you merge because the bot opened a PR and the tests passed.

A surprising number of production incidents originate in dependency upgrades that looked routine. The asymmetry: a missed update can carry a real CVE, but a sloppy update can break production. Both failure modes are common. The discipline below is meant to reduce both without making upgrades so expensive that you avoid them entirely.

## Step 1: classify the update

Not every update needs the same level of scrutiny. Classify before deciding how much work to do.

- **Patch update of a low-risk dep.** Logging, formatting, test utilities. Read the changelog summary; merge if it looks routine. The full procedure is overkill.
- **Minor update of a high-risk dep.** Framework, ORM, auth library, anything in the request hot path. Full procedure.
- **Major version bump.** Always full procedure. Major versions are where breaking changes hide, even when they're documented.
- **Security patch.** Full procedure for the changes themselves, but on a faster timeline. Don't skip the procedure; do compress it.
- **Transitive-only update.** Your direct deps didn't change, but a dep-of-a-dep updated. Same procedure; the surface that changed is upstream.

Risk level is not just the dep — it's the dep crossed with how you use it. A major version of an ORM is high risk because you use it everywhere. A major version of a test-only formatter is low risk because nothing in production touches it.

## Step 2: read the changelog

The single most undervalued step. Most engineers skip straight to "run the tests"; the changelog tells you what to look for.

What to look for in the changelog:

- **Breaking changes section.** Always. Even on minor versions some libraries lie about semver. Read every entry.
- **Removed features.** Anything removed will break callers; grep your codebase for the removed symbols.
- **Behavior changes that aren't marked breaking.** Subtle: default values changed, error types changed, async semantics shifted. These often slip past tests.
- **Deprecation notices.** New deprecations are not blocking, but they're the warning shot for next major.
- **Security advisories referenced.** Cross-check that the update actually addresses the advisories you care about.

If the changelog is sparse or missing, treat the update as higher risk. Libraries that don't bother documenting changes don't bother being careful about them.

For transitive-only updates, the changelog of the indirect dep matters more than the changelog of the direct dep. Follow the chain.

## Step 3: semver discipline (and when libraries lie)

Semver says: major = breaking, minor = additive, patch = fixes. In practice:

- **Major version bumps.** Always assume breaking changes, even when "breaking" is narrowly scoped. The library author and you may disagree on what counts as breaking.
- **Minor version bumps.** Usually safe, often not. New features can change defaults; new optional parameters can shadow your overrides; performance changes can shift behavior under load.
- **Patch version bumps.** Mostly safe. The exception is bugfixes that "fix" behavior your code depended on. A bug-fix patch can break code that was bug-compatible.

The signal that a library is loose with semver: their changelog routinely lists "minor breaking changes" in minor versions, their major versions are infrequent and huge, or their issue tracker is full of "this broke me in version X.Y.Z+1". For these libraries, treat patches as minor and minor as major.

The lockfile is your only protection against semver lies. Commit the lockfile; never manually edit it; let the package manager regenerate it. Two engineers running `npm install` on different days should not produce different dependency trees.

## Step 4: scope the change

One dep at a time, when possible. Reasons:

- **Failure attribution.** If the test suite breaks, the culprit is obvious.
- **Rollback granularity.** Reverting one upgrade is cheaper than reverting a bundle.
- **Review tractability.** A reviewer can read one changelog; they cannot read fifteen.

The exception is when deps must move together (peer-dep constraints, related libraries that share types). In that case, bundle the related set, but call it out in the PR description.

The other exception is dependency batches with no production code reachability (test runners, linters, dev tooling). Bundle these; the blast radius is small.

For Dependabot or Renovate PRs that batch many updates: split them. One PR per dep is cheap; one PR for thirty deps is impossible to review.

## Step 5: identify what tests cover this dep

For a dep you're upgrading, ask: which tests exercise the code that uses this dep?

- **If you can't answer**, the test coverage for that dep is unknown. Treat the upgrade as higher risk. Consider writing characterization tests before the upgrade (see `refactoring-safety` for the technique).
- **If unit tests are the only coverage**, you'll catch shape regressions but not behavior regressions under load. Run integration tests too.
- **If there are no integration tests**, an upgrade of a framework or runtime dep deserves a manual smoke test in a staging environment before merge.

The pattern: identify the most-used surfaces of the dep in your code (a 10-minute grep), then run the tests that exercise those surfaces. If none exist, write at least one or accept the risk explicitly.

## Step 6: peer-dep and transitive-dep traps

Peer dependencies are upgraded by you but used by other deps. If you upgrade React, all your React-dependent libraries have to be compatible with the new version. Look for:

- Warnings during install about unmet peer dependencies.
- Deps that haven't been updated in over a year — they may not have published a version compatible with new peer deps.
- Type errors after upgrade — peer-dep types often shift in major versions.

Transitive deps are upgraded indirectly when your direct deps update. The risks:

- A dep-of-a-dep might add a new transitive dep with its own vulnerabilities.
- The transitive dep tree can swap for an incompatible version when the direct dep allows a range.
- `npm audit` and equivalents flag transitive vulnerabilities; the fix is usually on the direct dep that pulls them in, not on your direct dep list.

Use `npm ls`, `cargo tree`, `pip show`, or equivalent to see the actual tree after upgrade. Diff it against the previous tree to spot surprises.

## Step 7: security-patch fast path

When the upgrade is specifically for a security patch, the urgency changes the procedure. The compressed version:

1. **Verify the CVE applies.** Just because the vulnerable version is in your tree doesn't mean the vulnerable code path is reachable. If your code doesn't use the affected feature, the urgency is lower.
2. **Identify the minimal upgrade.** The smallest version bump that addresses the issue. Avoid combining the security patch with a feature bump.
3. **Run the affected-surface tests.** If the security fix is in a network parser, run the tests that exercise network parsing.
4. **Ship with monitoring.** Watch error rates and latency for 24 hours post-deploy. Security patches sometimes introduce performance regressions.

Do NOT skip the procedure entirely. "It's a security patch" is not a reason to merge unread. The security side of `security-review` applies here too.

If the dep is dead (no recent releases, no maintainer activity), the security patch may not be available. Decide between forking (you maintain it), replacing (different library), or accepting (document the risk and add compensating controls).

## Step 8: rollback planning

Every upgrade ships with a rollback plan, even if it's "revert the PR". The plan has three components:

- **Detection.** What signal tells you the upgrade broke something? Error rate spike, latency regression, a specific failing user journey. Define before deploy, not after.
- **Rollback action.** `git revert` of the PR, redeploy of the previous build, downgrade in the package manifest. Document the command.
- **Floor pin.** If the upgrade is reverted, the floor stays — don't let the package manager re-upgrade on the next install. Pin to the previous version explicitly in the manifest.

The most common rollback failure: the upgrade is reverted, the manifest range still allows the broken version, and the next CI build re-pulls it. Pin explicitly when rolling back.

## Step 9: "is this dep dead" check

Before upgrading to a marginally-better version of a slowly-dying dep, ask whether you should be on this dep at all. Signals:

- **Last release date.** If the last release is over 18 months ago, the maintainer may have moved on. Not a hard rule (some deps are feature-complete) but worth checking.
- **Issue count and age.** Hundreds of open issues, slow response, releases that don't address top issues — bad signs.
- **Maintainer signal.** Single maintainer who hasn't commented in a year is fragile. Multi-maintainer projects survive transitions better.
- **Forks and alternatives.** A successful fork is a strong signal the original is unmaintained. Check whether the fork is the new home.

If the dep is dying, the security-patch path becomes: stay on the patched version for now, plan the replacement separately.

## Step 10: changelog reading practical tips

Practical mechanics that save time:

- **Read the changelog from your current version forward.** Don't just read the latest release; read every release between yours and the target. Each release's "breaking changes" section is what matters.
- **Search for the dep's name in your codebase first.** Then read the changelog with your usage in mind. A change to a feature you don't use doesn't matter to you.
- **Check the migration guide.** Major versions often ship a separate migration guide. Read it; the changelog summarizes, the migration guide explains.
- **Read the PR descriptions for the actual changes.** If the changelog is thin, the underlying PRs often have more detail.
- **Watch for "this is now strict" changes.** Validation that was permissive becoming strict catches real bugs but also catches your code's reliance on the previous looseness.

## Common anti-patterns

- **Merging because tests passed.** Tests cover what you tested. Dep changes can break code paths your tests don't exercise.
- **Merging without reading the changelog.** Always a smell.
- **Editing the lockfile by hand.** The lockfile is generated; editing it desynchronizes from the manifest and creates ghosts.
- **Pinning to exact versions everywhere.** Stops Dependabot from helping you. Better to pin meaningfully (major or major.minor) and let patches flow.
- **Floating to "latest".** The other extreme. Every install pulls a different tree. Never in production.
- **Batching all updates into one quarterly upgrade sprint.** The bigger the batch, the harder the bisection when it breaks. Continuous upgrade beats batched upgrade.
- **Treating "version went up but my code didn't change" as zero risk.** Transitive updates can be the biggest source of surprise. Diff the dep tree.
- **Skipping the procedure on dev/test deps.** Usually fine, but the build pipeline runs in CI and CI is production-for-CI. A broken test runner blocks releases.

## Working with a deps audit on a long-stale codebase

Sometimes you inherit a codebase where deps haven't been touched in months or years. The default procedure (one dep at a time, careful review) is correct in steady state but produces an unbounded backlog when starting from this position.

The phased recovery pattern:

1. **Audit the security exposure.** Run `npm audit`, `cargo audit`, `pip-audit`, or equivalent. Identify the high/critical CVEs in your tree. These are the priority targets.
2. **Group the security patches into a "safety bundle".** Upgrade only the deps with active CVEs to the minimum version that addresses the CVE. Don't combine with feature bumps.
3. **Ship the safety bundle as one PR.** Yes, this violates the "one dep at a time" rule. The justification is the security exposure; document it in the PR.
4. **After the safety bundle, switch to normal continuous-upgrade cadence.** From this point forward, one dep at a time.
5. **Major-version backlog over weeks or months.** Schedule major-version upgrades as deliberate work, one or two per sprint. They're each their own effort and don't fit the daily flow.

The principle: clearing a backlog requires a temporarily different process. Don't try to apply normal-state discipline to a backlog clearing — you'll either ship one PR a day for a year or you'll lose discipline entirely.

## Coordinating across team boundaries

When multiple teams share dependencies (a monorepo, a deployed shared library, a centrally-managed framework), upgrades have coordination costs the single-team procedure doesn't address.

- **Shared lockfile in monorepos.** A monorepo with a single lockfile means a dep upgrade affects everything. Run the affected-tests across all packages, not just the package that "owns" the upgrade. Most monorepo tooling supports this; use it.
- **Major version coordination.** If one team is on version X and another is on X+1 of the same dep, the next major upgrade is twice as hard. Co-version through coordination: schedule major upgrades when both teams can absorb them, run them simultaneously.
- **Internal libraries.** Treat internal libraries the same way as external ones for the upgrade process. Internal authors are often less rigorous about semver; consumer teams suffer.
- **Communication channels.** A shared channel (Slack, mailing list) for "upgrade is being planned" reduces surprise. Teams that consume the dep can flag concerns before merge.

The single-team procedure is the baseline. Coordination is the addition for shared deps.

## When the upgrade is involuntary

Some upgrades are forced: the registry pulls the old version, a backend system requires the new client, a CVE is severe enough to require immediate action regardless of breakage risk. The procedure compresses but doesn't disappear.

- **Identify the minimum-acceptable upgrade.** Smallest version that satisfies the forcing function.
- **Acknowledge the risk.** Document what you couldn't verify, what could break, what monitoring you'll watch.
- **Ship with extra observability.** Logs, metrics, error tracking turned up during the migration window.
- **Plan the rollback even though you can't actually go back to the old version.** The rollback may be forward to yet another version, or to a fork, or to a feature flag disabling the affected functionality. Have it ready.

Involuntary upgrades are where most production incidents come from. The discipline is to absorb them carefully rather than absorbing them quickly.

## Output format

When this skill is invoked, produce:

1. **Classification** — patch/minor/major/security, low/medium/high blast radius.
2. **Changelog summary** — relevant breaking changes, behavior changes, deprecations.
3. **Use-in-codebase summary** — what surfaces of the dep are reachable from production code.
4. **Test coverage assessment** — what tests exercise the affected surfaces, what gaps exist.
5. **Risks** — specific things that could break, ranked.
6. **Rollback plan** — detection signal, rollback action, floor pin.
7. **Recommendation** — proceed, hold pending mitigation, escalate, replace dep entirely.

## Related skills

- `security-review` — when the upgrade is security-driven or when the dep adds attack surface.
- `refactoring-safety` — when a major upgrade requires real code changes; characterization tests first.
- `architecture-decision-records` — for upgrades that change the architectural shape (e.g. swapping ORM, replacing auth library).
- `monitoring-and-alerting` — design the detection signal that tells you the upgrade broke something post-deploy.
