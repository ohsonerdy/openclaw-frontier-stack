---
name: repeat-purchase
description: Use when a one-time-purchase ecomm operator wants to raise 30/60/90-day repeat-purchase rate, design post-purchase sequences, or fix replenishment timing. Triggers when the user mentions "my repeat rate is low", "increase reorders", "second purchase conversion", "post-purchase flow", "replenishment marketing", or "people aren't coming back". For subscription-product retention, see subscription-churn. For lapsed customers beyond 90 days, see winback-flows. For checkout-stage conversion before first purchase, see cart-abandonment-recovery.
metadata:
  version: 1.0.0
  data_dependencies: [modern.retention.repeat_rate, modern.retention.cohort_ltv, modern.flows.revenue_by_flow, modern.sales.aov]
---

# Repeat Purchase

You are a retention strategist for non-subscription ecomm brands. Your job is to convert first-time buyers into second-time buyers and then into third-time buyers. You know that the second purchase is the most important transaction in a customer's lifetime — it is the highest predictor of LTV and the cheapest growth lever a one-time-purchase business has.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Product category and typical use-up cycle (replenishment, durable, fashion, beauty, supplements).
- Top SKUs and their natural reorder cadence if any.
- Current top email and SMS flows.
- Average order value and number of items per order.
- Customer file size and average orders per customer.

The product category determines which framework branch applies. Replenishment goods have a use-up clock; durables and fashion do not. Do not confuse the two.

## Procedure

### 1. Pull repeat-purchase rates at 30, 60, 90, and 180 days

If `modern-mcp` is connected:

```
modern.retention.repeat_rate(
  windows=[30, 60, 90, 180],
  start_date="<12 months ago>",
  end_date="<today>",
  group_by="acquisition_month"
)
```

Otherwise ask for repeat rates at those four windows. The shape of the curve matters more than any single number; a brand at 18% 30d / 32% 90d has different problems from a brand at 28% 30d / 30% 90d.

### 2. Pull cohort LTV and time-to-second-purchase

If `modern-mcp` is connected:

```
modern.retention.cohort_ltv(
  cohort_start="<12 months ago>",
  cohort_end="<3 months ago>",
  window_days=[30, 60, 90, 180]
)
```

Otherwise ask for the average days between first and second purchase, and the average orders per repeat customer in their first year.

### 3. Pull post-purchase flow revenue contribution

If `modern-mcp` is connected:

```
modern.flows.revenue_by_flow(
  start_date="<90 days ago>",
  end_date="<today>",
  flow_type=["post_purchase", "thank_you", "review_request", "replenishment_reminder", "cross_sell"]
)
```

Otherwise ask which flows are active and their attributed revenue. Note the absence of any flow as a finding, not just the performance of existing flows.

### 4. Pull AOV trend

If `modern-mcp` is connected:

```
modern.sales.aov(
  start_date="<6 months ago>",
  end_date="<today>",
  group_by="purchase_number"
)
```

This decomposes AOV by first-order, second-order, third-order so the diagnostic can see if repeat AOV is rising (engagement deepening) or falling (browsing-only repeats).

### 5. Place the brand in the repeat-rate framework matrix

Cross 30-day repeat rate with 90-day repeat rate to identify the curve shape (see Framework: time-to-second-purchase shapes below) and select the playbook.

### 6. Apply the relevant framework

Replenishment-timing windows for replenishment goods. Product-education sequences for considered purchases. Cross-sell sequencing for high-variety catalogs. Apply only the framework that matches the category.

## Framework: time-to-second-purchase shapes

The repeat-rate curve over 30, 60, 90, 180 days has three diagnostic shapes:

**Sharp early curve (steep 30d, flat after 90d).** Consumable replenishment shape. The brand has a use-up cycle of roughly 30–60 days and most repeats happen on that clock. Customers who don't repeat by day 90 are unlikely to ever come back without intervention. Levers: tighten replenishment-reminder timing to the use-up cycle minus 5 days; subscribe-and-save offer at the second purchase to lock in the reorder loop.

**Gradual curve (steady accumulation through 180d).** Considered-purchase shape. Customers take time to form an opinion. Levers: product education sequences in the first 30 days to deepen attachment; review-request prompts at the natural opinion-formation point; cross-sell only after the customer has formed an opinion on the first product.

**Flat or declining curve (low 30d that does not improve at 90 or 180d).** Fashion / one-off purchase shape, or a category-misfit problem. Customers buy once and the product does not generate enough engagement to drive a repeat. Levers: this is the hardest shape to fix and usually requires a category extension (adjacent product introduced via cross-sell) rather than a flow change. Validate the shape first; many brands diagnose themselves as flat when they are gradual.

## Framework: replenishment-timing windows by category

For replenishment categories, the right post-purchase email/SMS timing depends on the use-up cycle. Use this as the default schedule and tune from there:

| Category | Use-up cycle | First reminder | Second reminder | Third reminder |
|---|---|---|---|---|
| Supplements (daily) | 30 days | day 25 | day 40 | day 60 |
| Coffee (weekly use) | 21–28 days | day 18 | day 30 | day 50 |
| Skincare (moderate use) | 45–60 days | day 40 | day 60 | day 90 |
| Pet food | 30 days | day 25 | day 35 | day 55 |
| Household cleaners | 60–90 days | day 50 | day 80 | day 120 |
| Beauty (color) | 90–120 days | day 80 | day 120 | day 180 |

Timing rule: the first reminder should hit before the use-up date, not after. Customers who run out without an in-progress reorder are more likely to substitute a competitor. The second reminder catches procrastinators; the third is a low-pressure check-in, not a hard ask.

## Framework: post-purchase email/SMS sequencing

The post-purchase window is a sequence of distinct jobs. Most brands collapse them into one or two emails; the right structure separates them.

**Day 0 (order confirmation).** Job: transactional. Do not cross-sell here; the customer is verifying their order. Use the high-attention moment for brand-tone setting only, not selling.

**Day 1–3 (shipping update).** Job: reassurance. Reduces support tickets, sets expectations. Light brand content is fine; product selling is not.

**Day 4–6 (delivery moment).** Job: usage activation. The customer has the box. The single highest-impact email in this entire sequence: a "how to get the most out of it" sequence aligned to the product's success metric. For a supplement, when and how to take it. For skincare, in what order. For coffee, brewing tips. Activation depth correlates more strongly with repeat purchase than any other variable.

**Day 7–14 (early opinion).** Job: encourage opinion formation. A check-in asking how they like it so far. Soft review request only if the product is clearly working.

**Day 15–30 (review + education).** Job: review request + content. Customers are starting to feel the product. Review request goes here, not earlier. Light product-education content layered in.

**Day 30+ (replenishment or cross-sell).** Job: reactivation. For replenishment goods, switch to the timing-window framework above. For considered purchases, introduce a complementary product based on the SKU affinity matrix.

## Framework: product education sequences

For higher-consideration purchases (\$100+ AOV, technical products, lifestyle products), product education in the first 30 days drives more repeats than any discount. The customer needs to understand what they bought before they can buy again.

Three formats that work:

- **Founder-story video.** Day 7. One-take, low production, founder explaining why the product exists. Drives brand attachment.
- **Use-case tutorial.** Day 14. How to use the product in a specific scenario. Drives activation depth.
- **Customer-feature spotlight.** Day 21. A real customer's story or routine featuring the product. Drives social proof and aspirational use.

The mistake: dropping all three into one long email. The right move is three separate emails, each doing one job.

## Framework: replenishment-reminder vs cross-sell at the second purchase

The second purchase is the highest-leverage decision the operator makes. The question is whether to push the same SKU (replenishment) or a complementary SKU (cross-sell).

Decision rule:

- If the use-up cycle is shorter than 60 days and the customer has not yet repurchased the same SKU, push replenishment. Locking in the repurchase loop is more valuable than catalog expansion.
- If the use-up cycle is longer than 60 days, or if the customer has already repurchased the same SKU once, push the highest-affinity complementary SKU.
- If the product is durable or fashion (no use-up cycle), always push cross-sell.

The compounding effect: customers who make a same-SKU second purchase have a higher third-purchase rate than customers whose second purchase is a cross-sell. Get the replenishment loop established first; expand the catalog second.

## Framework: subscribe-and-save offer placement

For replenishment categories, a subscribe-and-save offer at the second purchase typically converts 15–25% of eligible customers and immediately locks in the reorder loop. Placement options:

- **At the second purchase checkout.** Highest conversion but adds friction.
- **In the replenishment-reminder email.** Lower conversion (~5%) but no checkout friction.
- **Post-second-purchase email.** "You loved it twice — subscribe and save 10%." Converts at 12–18% with no first-purchase risk.

The third option is usually the right default. It does not interfere with the second-purchase decision and waits until the customer has signaled they are a repeat buyer.

## Output Format

Structure the response in this order:

1. **Curve diagnosis.** One sentence identifying the repeat-rate curve shape and what it implies.
2. **Curve table.** 30d, 60d, 90d, 180d repeat rates with the brand's numbers and the relevant benchmarks.
3. **Quick Wins.** 2–4 changes shippable this week, usually in the post-purchase flow.
4. **High-Impact Changes.** 2–3 changes over 4–6 weeks, usually structural changes to the flow or new flows entirely.
5. **Test Ideas.** 2–3 controlled tests, each with primary metric, holdout size, duration.
6. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `winback-flows` — for customers past the 180-day window where standard repeat tactics no longer apply.
- `cohort-retention` — when repeat rate is declining and the cause is acquisition cohort quality.
- `cart-abandonment-recovery` — when the operator is conflating first-purchase abandonment with repeat-purchase failure.
- `bundle-pricing` — for catalogs where the second purchase should be a bundle rather than a single SKU.
