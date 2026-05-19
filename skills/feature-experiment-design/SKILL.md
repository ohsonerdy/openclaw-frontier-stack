---
name: feature-experiment-design
description: Use when designing an A/B test or experiment behind a feature flag — picking the primary metric, computing sample size and MDE, deciding frequentist vs Bayesian, planning analysis before the test runs. Triggers when the user mentions "experiment design", "A/B test statistics", "MDE", "minimum detectable effect", "sample size calculation", "experiment platform", "Bayesian vs frequentist", "CUPED", "guardrail metrics", "peeking", or "we ran an A/B test, what does it mean". The skill covers pre-registration discipline, MDE, peeking risks, variance reduction, guardrail metrics, and heterogeneous treatment effects. For the rollout mechanism (the flag itself), see feature-flagging. For the broader release workflow the experiment lives inside, see safe-public-release.
metadata:
  version: 0.1.0
---

# Feature experiment design

A feature flag without statistical discipline is just a way to ship code in production. An experiment is the discipline of comparing the new behavior against the old in a way that produces a defensible answer to "did this work?" Most experiments fail not because the feature didn't help but because the analysis can't tell whether it did.

This skill covers the design choices that happen before the experiment runs: hypothesis, primary metric, sample size, the framework choice, the guardrails. The mechanism for routing users to variants — the flag itself — is in feature-flagging. The two skills are siblings: feature-flagging knows how to flip a flag, feature-experiment-design knows what flipping it tells you.

## When to invoke this skill

- Designing a new A/B test or experiment.
- Reviewing an experiment design before it ships.
- Diagnosing an experiment whose result feels wrong or inconclusive.
- Deciding between frequentist and Bayesian analysis.
- Choosing the primary metric for an experiment.
- Adding guardrail metrics that prevent "winning" while damaging the long-term system.
- Auditing an organization's experiment hygiene (are we running experiments well, or are we generating noise?).

The signal to use this skill: someone is about to launch an experiment, or just finished one, and the analysis is about to be used to make a decision.

## Pre-registration discipline

The single highest-leverage practice in experiment design: write down the hypothesis, the primary metric, the success criterion, and the planned sample size before the test runs. The pre-registration is a contract between the experimenter and the future analysis.

The minimum pre-registration:

- **Hypothesis.** What you believe and why. "We believe variant B will increase metric X because Y."
- **Primary metric.** The single number that determines the outcome. Not three; not "we'll look at a bunch and see what's significant". One.
- **Direction.** Are you expecting the metric to go up or down? Two-sided vs one-sided test.
- **Success criterion.** What level of result triggers "ship it". An effect size and a confidence level.
- **Sample size and duration.** How many users (or sessions, depending on unit) you'll observe before reading the result.
- **Guardrail metrics.** What metrics, if they degrade, would invalidate a positive primary-metric result.

The pre-registration is durable. Write it down before the test starts; refer to it when the data comes in. The discipline prevents post-hoc hypothesis adjustment: "the primary metric was flat but conversion to checkout went up, so we'll declare that the win". That's not winning; that's metric shopping.

The most common failure mode: experimenters who read the test result, then write the hypothesis to fit. The result becomes a story; the test stops being evidence.

## Primary metric selection

The primary metric has to satisfy several constraints:

- **Sensitive to the change.** The metric must move when the feature works. A metric that's stable regardless of the feature is useless.
- **Measurable at the experiment's time horizon.** A metric that takes 90 days to converge isn't useful for a 14-day experiment.
- **Causally connected to the business outcome you care about.** Sometimes a proxy is necessary, but state the proxy explicitly and note its known biases.
- **Calculable from the data you actually collect.** "User happiness" is a goal; "click-through rate on the new feature" is a metric.

The proxy-vs-north-star question is unavoidable for most product changes. Click-through is a proxy for engagement, which is a proxy for retention, which is a proxy for revenue. The further from the north star, the more chance the experiment "wins" while not actually moving the business.

The remedy is to declare the proxy chain explicitly: "primary metric is CTR, which we believe predicts engagement (proxy), which we believe predicts retention (north star). We accept this proxy because measuring retention directly would require a 60-day test." If you can't justify the proxy, the experiment is testing the wrong thing.

A specific anti-pattern: picking three metrics, calling the most-favorable one "primary" after the test runs. This inflates the false-positive rate. If you genuinely care about three metrics, do the family-wise error correction (Bonferroni or equivalent) and treat each as one of several tests.

## Sample size and MDE

The minimum detectable effect (MDE) is the smallest difference between control and variant the experiment can reliably detect. Two relationships:

- **More users -> smaller MDE.** A test with 10,000 users can detect a 5% lift; the same test with 1 million users can detect a 0.5% lift.
- **More variance -> larger MDE.** A noisy metric requires more users to detect a given effect. Variance reduction (covered below) is the same as effective sample size increase.

The math: with a binary metric at baseline rate p, you need roughly 16 * p * (1-p) / (MDE)^2 users per variant to detect the effect with 80% power and 95% confidence. For p=0.10 and MDE=0.005 (5% relative lift, i.e., 0.10 to 0.105), you need around 600k users per variant.

The practical implication: if your product has 100k users per week and you want to detect a 5% relative lift on a 10% conversion rate, you need ~12 weeks of experiment time per variant. Most teams do not have that runway, which means either accepting a larger MDE (only the dramatic wins are visible), running longer (calendar cost), or reducing variance (CUPED, stratification).

The sample size calculation is the gate. Before launching the test, compute it. If you can't afford the sample, restate the MDE you can afford and decide whether that's still useful.

## Frequentist sequential testing and peeking

Most A/B test platforms default to frequentist tests with a fixed-horizon design: collect N users, run the test, report p-value. The implicit assumption is "you do this calculation once, at the end".

"Peeking" — looking at the result before N is reached and stopping if it looks significant — inflates the false-positive rate. The reason: at any moment during the test, random noise can produce a transient "significant" result that disappears as more data arrives. If you stop the moment you see significance, you're sampling the moments of maximum noise, not the true effect.

The standard frequentist test assumes one look. If you look at the test 10 times, your effective false-positive rate is much higher than the nominal 5%. Stopping when you see a "win" early produces "wins" that are noise.

The fixes:

- **Don't peek.** Pre-register the sample size, then look once when it's reached. The simplest and most reliable approach for most teams.
- **Group sequential testing.** A planned set of interim looks with alpha-spending — adjusted p-value thresholds at each look that account for the multiple-comparison cost.
- **Always-valid p-values.** A different statistical framework (e.g., mSPRT, conformal sequential) where the p-value is valid regardless of when you stop. Less common; requires platform support.

The honest practice: most teams aren't using group sequential or always-valid p-values. They're peeking with regular p-values and accepting the inflated false-positive rate without knowing they're doing it. Don't be that team.

## Bayesian alternatives

Bayesian analysis treats the effect size as a probability distribution rather than a binary "is it significant?". The posterior probability that variant B beats variant A is a number; it updates as more data comes in.

Advantages relative to frequentist:

- **Sequential-friendly.** The posterior is valid at any moment; stopping early doesn't break the math.
- **Intuitive output.** "There's a 92% chance B is better" is easier to communicate than "p < 0.05".
- **Naturally handles prior beliefs.** If you have strong prior evidence (a small earlier test, theoretical reasoning), the Bayesian framework incorporates it.

Disadvantages:

- **Requires a prior.** Default flat priors are often fine, but the choice is a modeling decision the analyst owns.
- **More computation.** Conjugate priors are fast; non-conjugate models can require sampling.
- **Cultural unfamiliarity.** Most engineers learned frequentist tests in school; the Bayesian framing requires explanation.

The choice between frequentist and Bayesian is mostly a function of platform support and team familiarity. The bigger decisions (pre-registration, primary metric, guardrails) matter more than the framework choice. For a team setting up experiment tooling for the first time, Bayesian with default priors is often easier to operate than frequentist with group sequential boundaries.

## Variance reduction

The MDE shrinks with effective sample size. Effective sample size grows with both raw N and variance reduction. The techniques:

- **CUPED (Controlled-experiment Using Pre-Experiment Data).** Adjust each user's outcome by their pre-experiment baseline behavior. For metrics correlated with pre-experiment activity (most engagement metrics), CUPED reduces variance by 30-50% — roughly doubles the effective sample size.
- **Stratified sampling.** Split assignment by a covariate (geography, device, plan tier) so each stratum is balanced. Reduces variance from imbalanced sample composition.
- **Outlier capping.** A small number of extreme users (top 1% of session length) can swamp the variance. Winsorizing (capping at the 99th percentile) reduces variance at the cost of some signal.
- **Filtering to relevant population.** A change to the checkout flow doesn't matter for users who never reach checkout. Restricting the analysis to users who entered the funnel reduces noise from irrelevant users.

CUPED is the highest-leverage technique for most engagement metrics. It's worth implementing in the experiment platform; the variance reduction is dramatic.

The discipline: variance reduction is part of the pre-registration. "We'll apply CUPED with pre-experiment metric X as the covariate" is decided before the test runs. Post-hoc variance reduction (trying different covariates until the result looks favorable) is a form of metric shopping.

## Guardrail metrics

The primary metric is what you're trying to move. The guardrail metrics are what you're trying not to move.

Examples:

- Primary: checkout conversion. Guardrail: refund rate (don't increase conversion by selling worse).
- Primary: time-on-site. Guardrail: bounce-back rate (don't increase time by trapping users on broken pages).
- Primary: feature adoption. Guardrail: complaints / support tickets (don't drive adoption while breaking the experience).
- Primary: ad-click-through. Guardrail: organic engagement (don't optimize ads while damaging the core product).

The guardrails are pre-registered alongside the primary metric. The rule: if a guardrail degrades materially, the primary-metric win is invalid regardless of significance. Ship-or-no-ship is conditional on the guardrails holding.

The honest version: many teams declare a primary metric, watch it move, and ignore the guardrails. The result is a portfolio of "wins" that collectively don't move the business — local optima at the expense of the global one.

## Heterogeneous treatment effects

The average treatment effect is one number. It hides the fact that different segments may respond very differently. Specific patterns:

- New users respond differently than power users. A change that improves engagement for new users may annoy power users who relied on the old behavior.
- Different geographies respond differently. A pricing change that works in one region may flop in another.
- Different platforms respond differently. A UX change on mobile may break a flow on desktop.

The analysis: report the primary metric not just in aggregate but split by the major segments. If the aggregate is positive but a major segment is strongly negative, the right call may be a segment-specific rollout rather than a universal ship.

The discipline: the segments to split by should be pre-registered. Post-hoc segmentation ("the test was flat overall but positive for users from Tuesday in California aged 25-30") is classic p-hacking. Pre-register the segments you care about; report each independently.

## The multi-test family-wise error correction

When you run multiple tests on the same data — multiple primary metrics, multiple variants, multiple segments — the chance of at least one false positive grows. With three independent tests at 5% each, the chance of one false positive is roughly 14%, not 5%.

The corrections:

- **Bonferroni.** Divide the alpha by the number of tests. Conservative; if you're testing 10 metrics, each must beat p=0.005 instead of p=0.05.
- **Holm-Bonferroni.** Sequentially adjusted; less conservative than Bonferroni.
- **False discovery rate (Benjamini-Hochberg).** Controls the expected proportion of false positives among rejections. Less conservative; useful when you genuinely expect many real effects.

The practical bar: declare in advance how many tests you're running and how you'll correct. The lazy version (run 10 tests, report the most significant) inflates the false-positive rate dramatically.

## Common anti-patterns

- **Hypothesis written after the result.** The post-hoc story turns a noise result into a "finding".
- **Three metrics, "primary" picked retroactively.** Metric shopping disguised as multi-metric analysis.
- **Peeking and stopping when it looks good.** Inflates false-positive rate; the "wins" are noise.
- **No guardrails.** The primary metric moves; the team ships; the long-term metric tanks.
- **Sample size calculated after the test.** The test was underpowered; the null result is "we couldn't tell", not "no effect".
- **Aggregate-only analysis.** Different segments respond differently; the aggregate hides the heterogeneity.
- **Running 30 experiments simultaneously without correction.** At 5% nominal alpha, at least 1.5 false positives per launch.
- **Treating a Bayesian "85% probability of improvement" as approval to ship.** Set the bar (e.g., 95% or 97%) and stick with it.
- **No pre-registration.** The post-hoc analysis is unconstrained and unfalsifiable.
- **Reading the experiment platform's report as truth.** The platform implements specific methods; understand the methods or trust the platform.

## Output format

When this skill is invoked to design an experiment, structure your output as:

1. **Hypothesis.** What you believe and why.
2. **Primary metric.** Definition, calculation, sensitivity to the change, direction.
3. **Sample size and MDE.** Calculated from baseline rate and variance estimate.
4. **Framework.** Frequentist (with peeking discipline) or Bayesian (with prior choice).
5. **Variance reduction.** CUPED, stratification, filtering — declared in advance.
6. **Guardrail metrics.** What would invalidate a primary-metric win.
7. **Segments.** What heterogeneous effects to look for, pre-registered.
8. **Decision criterion.** What result triggers ship-or-no-ship.

## Related skills

- `feature-flagging` — the mechanism for routing users to variants. The flag is the rollout; the experiment is the analysis.
- `safe-public-release` — the broader release workflow that experiments live inside.
- `cohort-retention` (Modern Skill) — for retention-focused experiments where the primary metric is a retention curve.
- `monitoring-and-alerting` — guardrail metrics often live in the same observability stack as production alerts.
- `incident-response` — if an experiment causes a guardrail breach severe enough to be an incident, the experiment is the change to revert.
- `postdeploy-verification` — after an experiment ships its winning variant, verify the production behavior matches the experiment's predicted effect.
