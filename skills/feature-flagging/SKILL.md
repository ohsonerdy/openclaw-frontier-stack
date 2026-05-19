---
name: feature-flagging
description: Use when adding, designing, or removing a feature flag. Triggers when the user mentions "feature flag", "rollout strategy", "kill switch", "gradual rollout", "percentage rollout", "cohort flag", "remove this flag", "flag debt", "sticky bucket", or "is this flag still needed". The skill covers flag taxonomy, default-state decisions, kill-switch design, percentage targeting, telemetry-on-flags, and the deletion lifecycle that prevents flag debt. For the broader release workflow flags exist inside, see safe-public-release. For the on-call response when a flag flip is part of mitigation, see incident-response.
metadata:
  version: 0.1.0
---

# Feature flagging

Feature flags are a tool for separating "the code is shipped" from "the user sees it". Done well, they let you ship continuously, roll out gradually, and turn off broken behavior in seconds. Done poorly, they become a graveyard of dead conditionals that nobody is willing to remove, a source of incidents when stale flags fire unexpectedly, and a way to ship code that was never actually verified at full traffic.

The discipline of feature flags is: know which kind of flag you're creating, design the default state deliberately, instrument the flag, and own the removal date from the day you add it.

## When to invoke this skill

- Adding a new feature flag — picking the kind, the default state, the targeting.
- Removing an old feature flag and finding it's wired into more places than expected.
- Designing a kill-switch for a risky change.
- Investigating a flag-related incident (sticky-bucket leak, percentage drift, default-on regression).
- Auditing the flag inventory and discovering more than you remembered.
- Using flags as part of an experiment or A/B test.

A flag without a defined kind, default, and removal owner is technical debt the moment it lands. This skill is how to avoid that.

## Flag taxonomy

Not all flags are the same; conflating them is how the system rots. The four kinds:

- **Release toggle.** The flag exists so you can decouple code-ship from user-see. The intended lifespan is short (days to weeks). Default off until the feature is verified, then default on, then the flag is removed entirely. Most flags are this.
- **Experiment toggle.** The flag exists so you can A/B-test variants and pick a winner. The lifespan is the experiment duration (typically 2-6 weeks). After the experiment, the winner becomes the default and the flag is removed.
- **Ops toggle / kill switch.** The flag exists so you can disable a code path at runtime, in seconds, without a deploy. Lifespan is indefinite — these stay forever. Treated as production infrastructure: tested, monitored, documented.
- **Permission flag.** The flag exists to gate access to a feature by customer tier, role, plan, or contract. Lifespan is indefinite. Treated as part of the authorization model, not a release tool.

Confusing them is the most common flag failure. A release toggle that was supposed to live for two weeks but is now four months old has silently turned into an ops toggle without the ops-toggle discipline (no monitoring, no documentation, no owner). An ops toggle that was treated as a release toggle has been deleted "because we don't need it anymore" — except now there's no kill switch when the next incident hits.

When creating a flag, write down which kind it is in the flag's metadata or in the PR description. The kind determines the lifecycle.

## Default state decision

The default state of a flag (when the targeting rules don't match) is the most under-thought decision in flag design. There are two postures:

- **Off-default-safe.** When the flag service is down or the targeting rules don't match, the code behaves as if the flag is off. Useful for: new code that hasn't been verified yet, risky paths where the old behavior is the safer fallback, anything where "do nothing" beats "do the new thing wrongly".
- **On-default-fast.** When the flag service is down or targeting doesn't match, the code behaves as if the flag is on. Useful for: a permission flag where the default for unmatched users is "everyone gets the basic feature", or a kill-switch that's been on for two years and the off path is now untested.

The wrong default is dangerous. Off-default for a kill-switch means the moment the flag service fails, every user sees the failed-state path. On-default for an unverified release toggle means the moment the flag service fails, every user sees the unverified code at full traffic.

When in doubt: off-default-safe is the right answer for release toggles and experiments. On-default-fast is the right answer when "the new path is now the only tested path".

The decision should be documented in the flag's metadata. "What does this do when the flag service is unreachable" is a deployment-day question, not a 3am question.

## Targeting strategies

How the flag selects which users get which value. Pick deliberately; they have different failure modes.

- **Percentage rollout.** "5% of users see this." Used for: gradual rollouts where you want to limit blast radius. The percentage is bucketed by a stable identifier (user ID, session ID) so the same user gets the same answer across requests. Without stable bucketing, the same user sees the flag flip on and off mid-session.
- **Cohort flag.** "Users in this list see this." Used for: internal employees, beta testers, specific customers. Cleaner blast radius than percentage; harder to scale up.
- **User-attribute targeting.** "Users on plan tier X, in region Y, with feature Z enabled see this." Used for: permission flags. Composable, complex, and the rules drift over time — review them.
- **Sticky-bucket (deterministic hash).** A specific percentage rollout where the bucket assignment is computed from a hash of the user ID. Same user gets the same answer forever, even if you change the percentage. Required for experiments; preferred for any rollout where consistency matters.

The most common targeting bug is non-sticky percentage rollout. If your percentage is computed per-request without bucketing, the same user oscillates between treatment groups — they see the new UI on one page, the old on the next. This destroys experiments (you can't measure a user who randomly switches groups) and produces broken UX for everyone (animations restart, state appears to vanish).

Verify sticky bucketing before rolling out anything user-visible.

## Kill-switch design

A kill switch is a flag specifically designed to disable a code path in seconds. The design requirements are stricter than for a release toggle:

- **Instant flip.** From flag-flipped to behavior-changed in under 30 seconds. Anything slower is not really a kill switch; it's "a flag we hope works during an incident".
- **Observable.** Telemetry shows what state the kill switch is in, who flipped it last, when. During an incident, "is the kill switch actually engaged?" must be a 5-second question.
- **Idempotent.** Flipping the switch twice does nothing extra. The same state is the same state. Required so a panicked operator doesn't make things worse.
- **Tested in both states.** The off-path is exercised in CI or pre-prod. A kill switch that's been on for a year and gets flipped to off for the first time in production is a bet, not a switch.
- **Documented in the runbook.** The on-call playbook should say "if X is happening, flip kill switch Y" with the exact procedure. Discovering the kill switch's name mid-incident is too late.

The decision authority for kill switches is the on-call engineer with no approval. If approval is required, it's not really a kill switch.

## The "test both branches" discipline

Every flag has two code paths. Both must work. The common failure: the new path is tested aggressively (because it's the new code), the old path is assumed to work (because it shipped six months ago). Then the flag is rolled back and the old path is found to be broken — possibly because of an unrelated change that happened during the new path's life.

The discipline:

1. **Run both branches in CI.** The unit tests cover both states of the flag. A simple `for flag_value in [True, False]:` wrapping the test, or two test suites, or a matrix build.
2. **Smoke-test the old path on every PR.** Before any merge, the old path runs in CI. The new path also runs. Both must pass.
3. **Periodically exercise the old path in pre-prod.** A daily smoke run with the flag forced off catches drift before the rollback day.
4. **Be honest about which paths you cannot test.** Some flag combinations explode combinatorially. If you have 10 flags, you have 1024 states — you cannot test them all. Pick the load-bearing combinations.

## Telemetry on flags

You cannot operate a flag you cannot observe. The metrics every flag needs:

- **Bucket percentages.** What fraction of users are actually in each treatment, sampled live. Compare to the targeted percentage; drift means a bug.
- **Sticky leaks.** How often a user changes bucket within a session or day. Should be near-zero; high values mean non-sticky bucketing.
- **Effect metrics.** The user-impact metric the flag is supposed to move. For release toggles: error rate, latency, conversion. For experiments: the primary success metric.
- **Flag service health.** Latency to evaluate the flag, error rate on flag-service calls, fallback-to-default rate. A degraded flag service can silently move everyone to the default state.
- **Decision count.** How often the flag is evaluated. Useful for budgeting flag-service traffic and detecting accidentally-hot loops that hit the flag 100x per request.

Without these, a flag is a coin you flipped and never looked at again.

## Flag-debt cleanup

Every flag must have a removal owner and a removal date. The lifecycle:

1. **Add.** PR adds the flag with metadata: kind, default state, owner, expected removal date.
2. **Ramp.** Percentage rollout, monitor metrics, increase percentage.
3. **Default flip.** The flag's default becomes the new behavior. Most users no longer evaluate the flag.
4. **Stable period.** A defined window (1-4 weeks) where the new behavior is the production default and the flag is just a safety net.
5. **Removal.** The flag is removed from code. The old branch is deleted. The flag definition in the flag service is archived.

Flags that skip step 5 become permanent code clutter. After 3-6 months, the original engineer has forgotten which branch is the current one, and reading the code requires checking the flag service. Refactors avoid the area because they can't reason about both states.

The audit cadence: monthly review of flag inventory. Any flag past its expected removal date gets one of three resolutions:

- Removed (the new branch is the only branch).
- Promoted to kill-switch or permission flag (with the appropriate metadata change).
- Re-justified by the owner with a new removal date.

A flag with no owner and no removal plan is flag debt, the same way that an untested dependency is dependency debt.

## Retiring a flag without breaking users

The mechanics of removing a flag depend on what the flag does:

- **Release toggle, current default = new behavior.** Easy. Remove the flag, keep the new code, delete the old branch.
- **Release toggle, mixed traffic.** Move everyone to the new branch first (100% rollout), monitor for a stable period, then remove. Don't remove the flag while traffic is split.
- **Permission flag.** Don't remove. Make sure the gating logic is correct, but the flag stays as part of the authorization model.
- **Ops toggle / kill switch.** Don't remove. Verify it's tested in both states; keep it.

A specific danger: removing a flag that was used by a feature still in flight. The flag's "off" branch was the old behavior; if a customer is still on the old behavior (because they have an exemption, or because their region was excluded from rollout), removing the flag deletes their experience. Run the percentage to 100% genuinely — including any excluded cohorts — before removing.

## Flag scope and granularity

A flag can apply at different scopes; pick the smallest scope that does the job:

- **Per-request flag.** Evaluated on every request. Most common; most flexible; most expensive in flag-service load.
- **Per-session flag.** Evaluated once at session start, cached for the session. Cheap; sufficient for UI variants.
- **Per-user flag.** Evaluated once per user, cached across sessions. Required for sticky-bucket experiments.
- **Per-deployment flag.** Set at deploy time, no per-request evaluation. Useful when the flag value is the same for every user in this deploy (e.g. enabling a new code path during a deploy window).
- **Per-environment flag.** Different value in dev, staging, prod. Often the right shape for ops toggles tied to environment.

Common mistake: per-request evaluation of a value that's actually per-deployment. The flag service handles thousands of times more requests than needed, and the per-request latency adds up.

## The flag-service dependency

The flag service is a runtime dependency. The implications:

- **Flag-service downtime is your downtime.** If every request synchronously calls the flag service, an outage degrades or stops every request. Cache aggressively and degrade gracefully.
- **Flag-service latency adds to request latency.** Even a cached lookup has a cost; an uncached lookup may add tens of milliseconds. Profile the impact.
- **Cache invalidation matters.** A flag flip that takes 5 minutes to propagate is not a kill switch. The cache strategy must match the kill-switch SLA.
- **Local-only fallback.** When the flag service is unreachable, fall back to a baked-in default per flag — not "fail open" globally. The default is per-flag and matches the deliberate off-default-safe or on-default-fast decision.

A flag service that's a single point of failure for your entire request path is worse than no flag service. Design it to fail gracefully or run it co-located.

## Output format

When this skill is invoked to design or audit a flag, structure your output as:

1. **Flag kind** — release / experiment / ops-kill-switch / permission.
2. **Default state and rationale** — off-default-safe or on-default-fast and why.
3. **Targeting strategy** — percentage / cohort / attribute / sticky, with the bucketing identifier named.
4. **Telemetry plan** — bucket percentages, sticky leaks, effect metrics, flag-service health.
5. **Both-branches test plan** — how the off-path is exercised.
6. **Lifecycle** — removal owner, expected removal date (for release/experiment), or indefinite-with-monitoring (for ops/permission).
7. **Runbook entry** — for kill switches, the procedure for engaging it during an incident.

## Flags and experiments

When a flag is used to A/B test (an experiment toggle), the discipline gets stricter:

- **Sticky bucket is non-negotiable.** A user must see the same variant for the entire experiment. Non-sticky bucketing destroys statistical validity.
- **The control branch must be implemented.** "Control" is whatever the user would have seen without the experiment. If you've already shipped the new code as the default, you can't honestly run a control.
- **Sample size matters.** A flag rolled out to 0.5% of users will take a long time to accumulate enough samples for significance. Plan the rollout percentage and duration with the expected effect size in mind.
- **Pre-register the success metric.** Decide what you're measuring before the experiment starts. Picking the metric afterward is data dredging.
- **Don't peek and stop early.** Running the experiment, looking at interim results, and stopping when it "looks significant" inflates the false-positive rate. Either pre-commit to the duration or use a sequential test that accounts for peeking.

A feature-flag platform makes experimentation fast; experimentation discipline is what makes the results meaningful. Without the discipline, you're shipping based on noise.

## Common anti-patterns

- **The flag with no owner.** Nobody knows what it does, nobody is willing to delete it, and it lives forever as code clutter.
- **The non-sticky percentage rollout.** Same user oscillates between treatments. Breaks experiments, breaks UX, looks like intermittent bugs.
- **The release toggle that became an ops toggle by accident.** A "we'll remove it in two weeks" flag is now six months old and the team treats it as production infrastructure without the discipline of one.
- **The untested old branch.** The new path is loved; the old path bit-rotted; the rollback is a discovery exercise.
- **Hot-loop flag evaluation.** Calling the flag service 100x per request. The flag service either becomes slow or returns the default under load, silently swinging traffic.
- **No instrumentation.** A flag rolled out at 5% with no metrics. You have no idea if it's working until users complain.
- **Removing a flag while traffic is split.** Cohorts that were excluded from rollout get the new behavior silently. Usually surfaces as a customer incident.
- **The kill switch nobody tested.** Year-old kill switch flipped during an incident, the off-path is broken. The incident is now two incidents.
- **Stacking flags without combinatorial testing.** Ten flags is 1024 states. Most are untested. The combinations that fire in production are rarely the combinations you tested.
- **Using a release toggle to ship a permission flag.** The "release toggle" outlives the rollout because it's actually gating per-customer access. The metadata says one thing; the behavior says another.

## Related skills

- `safe-public-release` — the broader release workflow flags exist inside.
- `incident-response` — when a flag flip is part of mitigation, the kill-switch design above must already be in place.
- `monitoring-and-alerting` — the telemetry-on-flags section above is a special case of the broader observability discipline.
- `api-deprecation` — flags are often used as part of a deprecation rollout (gate the old path off behind a flag, then remove).
- `dependency-upgrade-safely` — for major upgrades, a flag can let you split traffic between old and new versions during the migration.
- `load-testing` — when rolling out behind a flag, load test the new path at the target percentage before ramping further.
- `logging-discipline` — emit a structured log when a flag's evaluation falls back to the default state. The fallback rate is a flag-service health metric.
- `architecture-decision-records` — document the flag-service choice and the kill-switch SLA as an ADR; future operators reading the system need this context.
- `oncall-rotation-design` — kill-switch design above must include the runbook reference the on-call uses at 3am.
