---
name: postdeploy-verification
description: Use when designing or executing the verification that runs after a production deploy — automated smoke tests, canary metric checks, manual checklist, rollback signals. Triggers when the user mentions "post-deploy verification", "deploy verification", "smoke tests in prod", "canary metrics", "rollback signal", "did the deploy actually work", "post-release checks", or "we shipped, now what". The skill covers the "deploy succeeded does not equal deploy worked" rule, automated smoke tests, canary metric thresholds, rollback triggering criteria, manual verification, and the post-mortem-driven addition of new checks. For the broader release workflow this lives inside, see safe-public-release. For the database-side checks specific to schema migrations, see database-migration-safety.
metadata:
  version: 0.1.0
---

# Post-deploy verification

The deploy pipeline says "succeeded". The CI status is green. The team moves on. Six hours later, customer support is flooded with tickets because the deploy broke something the pipeline didn't check for. The verification gap between "deploy completed" and "deploy worked" is where most preventable incidents live.

The discipline of post-deploy verification is to treat "the deploy succeeded" as the start of verification, not the end. A successful deploy is a hypothesis: the new code is in production. The verification is the test that the hypothesis is correct.

This skill is the design and execution of those checks. The broader release workflow (gates, sign-offs, rollouts) is in safe-public-release; the database-specific checks are in database-migration-safety. This skill is the verification layer that catches what the rest of the pipeline doesn't.

## When to invoke this skill

- Designing the post-deploy verification for a new service or pipeline.
- Reviewing the verification that just ran on a recent deploy and wondering if it caught enough.
- Adding new checks after an incident that the verification should have caught.
- Choosing the canary metric thresholds that trigger rollback.
- Designing the manual verification checklist for high-risk deploys.
- Deciding who has authority to trigger a rollback and on what evidence.
- Auditing the existing verification: is it actually running? Is it actually catching things?

## The "deploy succeeded does not equal deploy worked" rule

The pipeline can say "succeeded" while the deploy is actively broken. The pipeline's success criterion is usually "the new artifact is in production and the health check passes once." That is a much weaker claim than "the deploy is working correctly."

Specific gaps between "pipeline succeeded" and "deploy worked":

- **The health check is shallow.** It returns 200 because the service started, not because the service can actually serve traffic. The shallow check doesn't exercise the database connection, the cache, the downstream calls.
- **The deploy is a percentage rollout.** The pipeline succeeds when 1% is live. The other 99% is broken; nobody knows yet.
- **The deploy bypasses some traffic.** Background jobs, scheduled tasks, async consumers. The pipeline checks the request-response path; the cron job that runs at 2am isn't tested until 2am.
- **The deploy introduces a slow-burn issue.** Memory leak, file descriptor leak, gradually-growing queue. The deploy looks fine for an hour; the leak surfaces at hour six.
- **The deploy depends on a database migration that ran separately.** The migration ran; the code expects the migration's shape; if the migration didn't actually complete, the code is broken in ways the pipeline can't see.
- **The deploy depends on a feature flag that's not in the right state.** Code is correct; behavior is wrong because the flag is off (or on) in production.

Each gap is a category of post-deploy verification check. The goal is not to test everything (you can't); it's to identify the failure modes that have bit you before and add verification specifically for them.

## Automated post-deploy smoke tests

The first line of defense: automated tests that run against production immediately after the deploy, exercising the critical paths.

The properties of a useful smoke test:

- **Exercises the actual production path.** Hits a production URL, uses production-shaped data, validates production-shaped responses. Not a synthetic that exercises the deploy pipeline; a synthetic that exercises the application.
- **Fast.** Runs in seconds, not minutes. The smoke test runs immediately after the deploy and gates the next stage (or the manual all-clear).
- **Fail-loud.** A failed smoke test pages someone immediately. A failed smoke test that just logs and continues is worse than no smoke test, because it produces false confidence.
- **Covers the load-bearing paths.** Sign-in, the most common API endpoints, the checkout flow. Not every endpoint; the ones whose failure would be visible quickly.
- **Idempotent and safe.** The smoke test can run repeatedly without polluting production data. Uses dedicated test accounts, cleans up after itself, or operates against read paths only.

The volume calibration: 5-20 smoke tests for most services. Many enough to cover the load-bearing paths; few enough that they don't take 10 minutes to run.

A specific anti-pattern: smoke tests that test the deploy infrastructure (does the container have a process running?) rather than the deploy semantics (does the application respond correctly?). The former is the pipeline's job; the latter is verification's job.

## Canary metric checks

For deploys that use canary rollouts, the canary's metrics are the most direct signal of "did the deploy break anything?" The canary serves a small percentage of traffic; its metrics are compared against the baseline.

The four metrics that catch most regressions:

- **Error rate.** The proportion of requests returning errors. A canary with 0.5% errors against a baseline of 0.1% is a 5x error regression; that's a rollback signal.
- **Latency p99.** The slowest 1% of requests. Latency regressions often hide in the tail; p99 is more sensitive than p50.
- **Traffic shape.** The mix of request types should be roughly similar between canary and baseline. A canary that's getting more or fewer of one request type than baseline suggests routing or selection bias; investigate before trusting the other metrics.
- **Resource consumption.** CPU and memory on the canary vs baseline. A canary that's using 30% more CPU per request indicates a regression even if user-visible metrics look fine; the regression will surface under full load.

The comparison is canary-vs-baseline, not canary-vs-absolute. A canary at 0.2% error rate may be a regression if baseline is 0.05%, or fine if baseline is also 0.2%. The reference is always the current production behavior.

The rollback triggering thresholds:

- **Error rate.** Canary > 1.5x baseline for 5 minutes. (Some teams use 2x; the threshold depends on baseline noise.)
- **Latency p99.** Canary > 2x baseline for 5 minutes. (Latency is noisier than error rate; the threshold is more permissive.)
- **Resource consumption.** Canary > 1.5x baseline for 10 minutes. (Resource regressions are slow; the window is longer.)
- **Any spike to a defined absolute threshold.** Error rate > 5%, latency p99 > 10 seconds. The absolute floor catches catastrophic failures regardless of baseline.

The thresholds should be calibrated to the service's baseline noise. A noisy baseline produces false-positive rollbacks; a quiet baseline can use tighter thresholds.

## Who pulls the rollback trigger

The rollback authority is part of the verification design. Decide in advance:

- **Automated rollback.** Canary metrics breach the threshold; the system rolls back without human approval. Best for the metrics that are reliably indicative (error rate spike, absolute threshold breach). Reduces incident response time to near-zero.
- **Human-approved rollback on alert.** The system pages the deploy owner; the owner reviews and approves. Best for metrics with more noise where false-positive rollbacks would be costly. Adds latency but adds judgment.
- **On-call rollback.** The on-call engineer has authority to rollback based on their assessment of canary metrics and customer signals. Pre-authorized; no approval chain. Same authority pattern as incident-response.

The combination that works: automated rollback for the clear catastrophes (error rate spike, absolute threshold breach), human-approved for the marginal cases (latency p99 slight degradation), on-call authority for the post-canary monitoring window when something subtle is going wrong.

The wrong pattern: rollback requires a manager approval. The window between "we see the regression" and "we can rollback" is the user-impact window. Approval chains expand that window; pre-authorization shrinks it.

## Manual verification checklist

For high-risk deploys, automated smoke tests aren't sufficient. A human runs through a manual checklist of critical user flows.

When to require manual verification:

- The deploy touches a critical user journey (checkout, sign-in, payments) and the smoke tests don't fully cover it.
- The deploy includes UX changes that automated tests can't verify (visual layout, copy, animations).
- The deploy is going out under reduced safety (no canary, expedited timeline, hotfix).
- A previous deploy of similar scope had a regression that the automated tests missed.

The checklist content (per critical flow):

- The user flow to walk through, step by step.
- The expected outcome at each step.
- A way to record the result (pass / fail / unclear).
- A bound on time (5-15 minutes per flow; longer means the flow is too broad).

The discipline: the manual checklist is part of the deploy. The deploy isn't complete until someone has actually walked through it. If the deploy happens at 5pm and the verification gets deferred to "tomorrow morning", the window of exposure is overnight; that's the actual deploy timeline.

A specific anti-pattern: the manual checklist that everyone scrolls past and clicks "all good". The checklist is useful only if it's actually executed. If the team is rubber-stamping the checklist, either the checklist content is wrong (not catching anything) or the discipline is broken (people are lying about running it).

## Feature flag readiness

Post-deploy is the natural moment to consider feature flag rollout strategy.

If the deploy introduces new code behind a flag, the deploy itself shouldn't activate the flag. The deploy is "code in production"; the flag is "behavior visible to users". The two are separate decisions.

After the deploy:

- The smoke tests run against the code with the flag in its default (usually off) state.
- The canary metrics validate that the code in the default state doesn't regress.
- The flag rollout — flipping the flag for some percentage of users — is a separate operation with its own verification.

The pattern: deploy with flag off; verify the deploy didn't regress baseline; then flip the flag for 1%; verify the canary metrics for the flagged behavior; then 10%; 50%; 100%.

For details on the flag design, see feature-flagging. For the experiment-style design where the flag has variants, see feature-experiment-design. The post-deploy verification is the precondition for any flag rollout: don't flip the flag if the deploy hasn't been verified.

## Post-mortem-driven verification additions

The verification you have today is calibrated to the incidents you've already had. New verification gets added when an incident surfaces a gap.

After every incident caused by a deploy, the post-mortem should answer:

- Could automated smoke tests have caught this? If yes, write the test.
- Could canary metrics have caught this? If yes, add the metric to the canary threshold.
- Could manual verification have caught this? If yes, add to the checklist.
- Or was this a category of failure the verification system can't catch (e.g., a slow-burn issue that surfaces hours after deploy)? If yes, add monitoring beyond the deploy window.

The post-mortem-driven addition is how the verification system improves. Without it, the same incident pattern keeps occurring; with it, the system catches more each time.

A specific failure mode: "we missed it because the test didn't cover this case" -> action item "add a test" -> action item never gets done -> next deploy has the same gap. The discipline is the same as the disaster-recovery-exercise-design action-item discipline: owner, deadline, verified-closed.

## Post-deploy monitoring window

The verification doesn't stop at the smoke test. The monitoring continues for a defined window after the deploy.

The window depends on the service's behavior:

- **For services with fast user feedback (web app, API).** 30-60 minutes is typical. Issues that affect user requests will surface in that window.
- **For services with slow user feedback (background jobs, scheduled tasks).** Hours to days. A daily-cron deploy is only "verified" once a cron has run.
- **For services with seasonal patterns.** A monthly billing job is only verified once a month runs. The verification window is the next instance of the job, not minutes.

During the monitoring window:

- Error rates, latency, resource use are watched against baseline.
- The on-call is paged automatically on threshold breaches.
- Rollback authority remains with the on-call.
- A defined "all clear" signal at the end of the window: someone confirms the deploy is fully verified.

The all-clear is the moment when verification responsibility transfers from the deployer to the regular on-call. Until the all-clear, the deploy is "recent and watching"; after, it's "the new baseline".

A specific failure mode: the deploy is "all clear" after the smoke tests pass, but the team didn't actually watch the metrics through the window. The slow-burn regression that surfaces at hour 5 then becomes an incident. The all-clear is conditional on the monitoring window; abbreviating the window abbreviates the verification.

## Synthetic vs real-user monitoring

Two complementary signals:

- **Synthetic monitoring.** Tests run continuously against production from controlled probes. Predictable, low-traffic, useful for the smoke-test layer and ongoing health checks.
- **Real-user monitoring (RUM).** Metrics from actual user sessions. High-volume, noisy, captures the behavior real users experience including the network conditions, devices, and edge cases that synthetic probes miss.

The post-deploy verification leans on synthetic for the immediate check (deterministic, fast) and on RUM for the slower-burn check (catches regressions that surface only at scale). A deploy that passes synthetic but degrades RUM is a real regression; trust RUM over synthetic when they disagree.

## Common anti-patterns

- **"Deploy succeeded" treated as "deploy worked".** The pipeline's success criterion is weaker than the verification's.
- **No smoke tests.** The first user request is the test.
- **Smoke tests that test the pipeline.** "The container is running" isn't the same as "the application works".
- **Canary metrics not compared against baseline.** Absolute thresholds miss regressions when baseline is already noisy.
- **Rollback authority requires approval chain.** The window between "we see it" and "we can rollback" is the user-impact window.
- **Manual checklist that everyone clicks through without reading.** Useful only if executed; rubber-stamping is worse than no checklist.
- **Deploy at 5pm with verification deferred to "tomorrow".** The verification window starts at deploy; deferred verification is exposure window.
- **Same verification for every deploy regardless of risk.** Low-risk deploys are over-verified; high-risk deploys are under-verified.
- **All-clear declared before the monitoring window closes.** The slow-burn regression surfaces at hour 4; the all-clear was at hour 1.
- **No post-mortem-driven verification additions.** The same incident pattern recurs because the verification didn't learn.
- **Feature flag activated during the deploy.** Couples code-shipped to behavior-shipped; loses the safety of separating the two.

## Output format

When this skill is invoked to design or execute post-deploy verification, structure your output as:

1. **The deploy's risk profile.** What's changing; what could break; what's the user-impact path.
2. **Automated smoke tests.** The 5-20 tests that run immediately; what each verifies; fail-loud behavior.
3. **Canary metrics.** Error rate, latency p99, traffic shape, resource consumption; thresholds vs baseline.
4. **Rollback authority.** Automated for catastrophes, human for marginal, on-call for the monitoring window.
5. **Manual verification.** If high-risk; the checklist of critical user flows; the timeboxes.
6. **Feature flag state.** What flags exist; the deploy's intended flag state; the planned rollout after verification.
7. **Monitoring window.** How long; what's watched; the all-clear criterion.
8. **Post-mortem additions.** Any verification added because of recent incidents.

## Related skills

- `safe-public-release` — the broader release workflow that post-deploy verification lives inside.
- `database-migration-safety` — when the deploy includes a migration, the migration's verification is its own concern.
- `feature-flagging` — flag rollout is a separate operation from deploy verification; flag activation happens after verification.
- `incident-response` — when verification fails, the response transitions to the incident playbook.
- `monitoring-and-alerting` — the alerts that surface verification failures are the same alerts that run production observability.
- `post-mortem-writing` — verification gaps are surfaced in post-mortems; the post-mortem drives the next iteration of verification.
- `disaster-recovery-exercise-design` — DR drills often exercise rollback paths; the same path verification depends on.
