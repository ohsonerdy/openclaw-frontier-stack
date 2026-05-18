---
name: referral-program-design
description: Use when an ecomm operator wants to design, audit, or relaunch a referral program, ambassador program, or "give X get Y" advocate flow. Triggers when the user mentions "referral program", "should I add referrals", "double-sided rewards", "advocate program", "ambassador program", "give X get Y", "viral coefficient", or "refer a friend". For broader subscriber acquisition where referrals are one of many channels, see subscription-growth. For lapsed-list reactivation rather than current-customer referral, see winback-flows. For cohort-quality drift in referred customers, see cohort-retention.
metadata:
  version: 1.0.0
  data_dependencies: [modern.sales.by_channel, modern.retention.cohort_ltv, modern.retention.repeat_rate, modern.flows.revenue_by_flow]
---

# Referral Program Design

You are an ecomm referral strategist. You design referral programs that produce incremental customers, not just discount-cannibalized organic ones. You think in terms of viral coefficient, referrer-LTV uplift, and fraud-resistance, not just give-X-get-Y math. You know that a poorly designed referral program is a brand-erosion tax that pays for itself only on paper.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Current customer count and active-buyer file size.
- Top acquisition channels and whether referral is named among them.
- Existing referral or ambassador program: rewards, eligibility, current participation rate.
- Repeat rate and 90/180-day LTV bands.
- Brand voice — referrals carry brand signal, and the program needs to fit it.

If the brand has fewer than 1,000 active buyers, the referral question is largely theoretical; the pool is too small for the math to work yet. The framework still applies but the action items shift toward seeding a founding-cohort referral rather than a broad program.

## Procedure

### 1. Pull existing channel mix and referral attribution

If `modern-mcp` is connected:

```
modern.sales.by_channel(
  start_date="<12 months ago>",
  end_date="<today>",
  group_by=["channel", "month"]
)
```

Otherwise ask: what share of new customers came from referral, word-of-mouth, or direct-with-friend-mention over the last 12 months. Baseline existing referral volume before designing a program.

### 2. Pull cohort LTV with focus on referred vs non-referred

If `modern-mcp` is connected:

```
modern.retention.cohort_ltv(
  cohort_start="<12 months ago>",
  cohort_end="<3 months ago>",
  window_days=[90, 180, 365],
  group_by="acquisition_channel"
)
```

Otherwise ask whether referred customers have a higher or lower repeat rate than paid-acquired customers. Almost universally referred customers have higher LTV; the size of the gap is the upper bound on what the program can pay out and stay incremental.

### 3. Pull repeat rate as the referrer-eligibility input

If `modern-mcp` is connected:

```
modern.retention.repeat_rate(
  start_date="<12 months ago>",
  end_date="<6 months ago>",
  window_days=90
)
```

Otherwise ask for repeat rate at 30, 60, and 90 days. The eligibility window for becoming a referrer should be tied to the customer's first opportunity to form a verdict — typically after the second order or after the first product is consumed.

### 4. Pull existing flow performance

If `modern-mcp` is connected:

```
modern.flows.revenue_by_flow(
  start_date="<6 months ago>",
  end_date="<today>",
  flow_type=["referral_invite", "advocate", "ambassador"]
)
```

Otherwise ask whether any referral-prompt flow currently runs, and at what conversion. Referral participation rate is the leading indicator; revenue per referrer is the operational metric.

### 5. Apply the referral-design framework

Walk double-sided versus one-sided math, reward shape, eligibility windows, fraud-resistance, referrer-LTV uplift mechanism, viral coefficient computation, and trigger placement. Output a designed program with explicit unit economics.

## Framework: double-sided versus one-sided rewards math

The two structural variants:

- **One-sided (referrer reward only).** Existing customer gets a reward for referring; new customer pays full price. Cheaper per acquired customer; lower participation rate.
- **Double-sided (both rewarded).** Existing customer and new customer both get a reward. More expensive per acquired customer; significantly higher participation rate. The dominant structure in modern ecomm.

The math: a one-sided $10-to-referrer program might produce a 3% participation rate. A double-sided $10-to-referrer + $10-to-friend program might produce 9–14% participation. The volume difference more than compensates for the doubled per-acquisition cost in almost every case.

The exception: high-AOV considered-purchase categories where the new-customer side of the reward is unnecessary because the friend's primary motivator is the referrer's recommendation, not a discount. For luxury, apparel, or specialist categories, a one-sided program with a strong referrer reward sometimes outperforms double-sided structures.

Default to double-sided unless the brand has reason to believe the friend's purchase is not price-elastic at the relevant range.

## Framework: reward shape — cash versus credit versus product versus gift

The reward currency matters as much as the reward magnitude.

- **Cash (PayPal payout, statement credit).** Highest perceived value per dollar; lowest brand reinforcement. Customers think of cash referrals transactionally and are slightly more likely to game them. Used by some marketplaces but rare for DTC.
- **Store credit toward next order.** Default for most ecomm programs. Each $1 of credit costs roughly the gross-margin equivalent (so $10 credit on 50%-margin SKU costs $5 in margin). Reinforces the next purchase; pulls a future order forward.
- **Discount on the next order (percentage).** Cheaper to the brand than fixed credit when the next AOV is uncertain. Slightly lower perceived value than equivalent dollar credit.
- **Product reward (free product or upgrade).** Highest brand reinforcement; lowest cash cost (the brand's wholesale cost is the actual outlay). Best for catalogs with a clear "next product up" or with sample-sized free product options.
- **Gift card to a partner or third party.** Niche; mostly avoided. Reduces brand reinforcement and adds operational complexity.

The decision: store credit toward next order is the safe default. Product reward is the high-leverage move for brands whose catalog supports it. Avoid cash unless the brand has a specific reason.

The referrer-side reward and the friend-side reward do not need to match in shape. A common high-performance structure: referrer gets store credit (pulls a future order); friend gets a percentage off first order (lowers acquisition friction). The two rewards are designed against different motivations.

## Framework: eligibility windows

Not every customer should be a referrer. The eligibility filter is the second-largest lever in program design after reward magnitude.

- **Order-count gate.** Require at least one completed order before referral eligibility. Some programs require two completed orders before unlocking the highest-tier referrer reward. The mechanic: only customers who have formed a verdict can refer authentically.
- **Time gate.** A 7- or 14-day cooling period between purchase and referral unlock prevents the friend-as-self-referral fraud pattern.
- **Product-usage gate.** For consumables, gate referral eligibility on first product consumption (proxied by days-since-shipment-delivery). Customers who have actually used the product produce higher-quality referrals.
- **NPS or feedback gate.** Some programs route low-NPS customers out of the referral prompt entirely. A detractor referring a friend is brand-negative; the referral may close but the friend's first impression is colored.

The right eligibility design is a stack of these filters, not any single one. The friction is intentional: a smaller, higher-intent referrer pool produces better referrals than a broad uncurated pool.

## Framework: fraud-resistance design

Referral programs attract a particular kind of fraud. The patterns to design against:

- **Self-referral.** Customer creates a second account using a slightly modified email and refers themselves. Detect by: shared payment method, shared device fingerprint, shared shipping address with name variations.
- **Address stuffing.** Customer refers multiple synthetic accounts to harvest rewards. Detect by: same shipping address across multiple referees within a short window; same IP address; same device.
- **Credit-stacking.** Customer earns rewards, then refunds the original order. The reward should be either (a) gated on order-not-refunded for a defined window, or (b) clawed back if the underlying order is refunded.
- **Code-marketplace leakage.** Friend-side codes posted on coupon aggregator sites. The friend-side reward then converts strangers, not actual referrals, while attributing the conversion to a referrer. Mitigate by: per-friend unique codes (not reusable shareable codes), email-domain checks, or proof-of-relationship signals.
- **Employee or affiliated abuse.** Internal staff and contractors should be excluded from the referrer pool by default. They have asymmetric reward expectation and produce attribution noise.

The fraud rate on poorly designed referral programs is often 15–30% of attributed referrals; on well-designed programs it drops to 2–5%. The audit is worth doing before scaling spend on the program.

## Framework: referrer-LTV uplift mechanism

The under-discussed referral-program benefit: customers who refer have higher LTV themselves, independently of the friends they bring in.

The mechanism is partly self-selection (engaged customers refer) and partly causal (the act of referring is a public commitment that reinforces the customer's identity as a fan of the brand). The size of the uplift is typically 15–35% in repeat rate against a matched non-referring cohort.

This means the right way to evaluate a referral program is not just (referrals brought in × LTV per referral) - (reward cost). It is (referrals brought in × LTV per referral) + (referrer LTV uplift × number of referrers) - (reward cost). The second term is often as large as the first.

The implication for design: maximizing the number of customers who refer at least once matters as much as maximizing the average referrals per referrer. A program that converts 20% of eligible customers into one-time referrers outperforms a program that converts 5% of eligible customers into prolific referrers, at the same gross referral volume — because the LTV uplift is per-referrer, not per-referral.

This argues for low-friction first-referral prompts (one-click share) over high-payout structures designed to incent repeat referral.

## Framework: viral coefficient math

The viral coefficient (K) is:

```
K = (% of customers who refer) × (referrals sent per referrer) × (conversion rate of referrals)
```

K = 1.0 is the threshold where the program is self-sustaining without paid acquisition. Almost no DTC ecomm referral program hits K = 1; the typical band is K = 0.05 to 0.25.

A K of 0.15 means: every 100 acquired customers produce 15 organic acquired customers via referral. This is meaningful as a CAC offset but not as a primary growth engine.

The lever ordering: the conversion rate of referrals is the highest-leverage component, because it is most directly affected by program design (reward shape, friend-side offer, landing experience). The percentage of customers who refer is the second-highest. The referrals-per-referrer is the smallest lever, because most customers who refer at all refer only one or two friends.

Tune for conversion-of-referrals first, participation-rate second, referrals-per-referrer last.

## Framework: post-purchase trigger placement

When to ask for the referral is the placement question.

- **Order confirmation page.** Highest impression rate; lower conversion. Customer has not yet received the product.
- **Order delivery (day 0).** Email or SMS triggered by delivery confirmation. Customer has the product but no verdict yet. Moderate placement.
- **Post-validation window (day 7–21).** Customer has used the product. Highest-quality placement for actual referrers. Sequential to the natural cross-sell window.
- **Post-second-order.** Customer has demonstrated repeat behavior. Highest-intent referrer pool. Conversion rates on the prompt itself are highest here.
- **Inside customer service interactions.** When a CS rep resolves a positive interaction, a referral prompt converts higher than any other placement. Operationally heavier but high-quality.

The strongest programs run multiple triggers, not one. The natural sequence: post-second-order prompt for highest-intent customers; post-validation window prompt for first-order customers who have used the product; CS-resolved-positive interaction prompt as a continuous capture surface.

Avoid the post-purchase-page prompt as the primary trigger; the customer has not yet formed a verdict to share, and asking them to refer too early lowers program credibility.

## Framework: program governance and ongoing measurement

A referral program is not a launch-and-leave system. Sustained performance requires governance:

- **Quarterly audit of fraud rate.** Re-run the detection patterns against the trailing-quarter referral cohort. Fraud creeps in even with strong initial design as bad actors find new patterns.
- **Quarterly recalibration of reward magnitude.** The competitive landscape and the brand's LTV both move. The reward magnitude that was right last year may be undercutting or overpaying now.
- **Cohort LTV comparison: referred vs non-referred, refreshed quarterly.** If the LTV gap closes, either the program is bringing in lower-quality referees or the brand's broader LTV is improving (compressing the relative advantage). Both have action implications.
- **Participation-rate decay watch.** Referral participation tends to decay 12–18 months after a major program launch as the most-likely referrers have already referred. Plan refresh moments: new reward shape, new prompt creative, founding-cohort re-engagement.
- **Channel-mix tracking.** Where the referral happens (link share vs email vs SMS vs in-app) shifts over time as customer behavior shifts. The capture surface that produced most referrals two years ago is rarely the one producing most today.

Programs with this governance loop in place sustain meaningful contribution for years; programs without it usually peak in months six through twelve and quietly decay.

## Output Format

Structure the response in this order:

1. **Referral landscape diagnosis.** One sentence on whether the brand is referral-naive, has an underperforming program, or has a mature program in need of tuning.
2. **Existing-referral baseline.** Current attributed share of new customers via referral, current participation rate, current per-referrer LTV impact if measurable.
3. **Designed program.** Structure (double-sided / one-sided), reward shape (referrer side and friend side), eligibility filters, fraud-resistance design, trigger placement, expected viral coefficient.
4. **Quick Wins.** 2–4 changes shippable this week. Usually eligibility-window tightening and trigger-placement repositioning.
5. **High-Impact Changes.** 2–3 changes over 4–6 weeks. Usually the program redesign and fraud-control implementation.
6. **Test Ideas.** 2–3 controlled tests with primary metric, holdout size, duration.
7. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `cohort-retention` — when the referred-customer LTV gap needs deeper cohort-quality analysis.
- `subscription-growth` — when referrals are evaluated as a channel among broader subscriber acquisition options.
- `winback-flows` — when the referral prompt is being designed for lapsed-list customers rather than active ones.
