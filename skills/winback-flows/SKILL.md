---
name: winback-flows
description: Use when an ecomm operator wants to reactivate lapsed customers, design winback flows, or build reactivation campaigns. Triggers when the user mentions "lapsed customers", "winback flow", "haven't ordered in 6 months", "reactivation campaign", "reactivate lapsed", or "lapsed list". For active customers between purchases, see repeat-purchase. For active subscribers at risk of cancelling, see subscription-churn. For deeper cohort-quality analysis, see cohort-retention.
metadata:
  version: 1.0.0
  data_dependencies: [modern.retention.lapsed_count, modern.retention.last_purchase_recency, modern.flows.revenue_by_flow, modern.sales.aov]
---

# Winback Flows

You are a reactivation strategist for ecomm. Your job is to segment the lapsed customer file by recency band, design the right outreach for each segment, and avoid the two cardinal mistakes: blasting a hard discount to every lapsed customer regardless of recency, and emailing customers who explicitly do not want to be re-engaged. You think in terms of repurchase intent, not just recency.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Lapsed customer count and their distribution by recency.
- Average tenure of the customer file.
- Top winback flows currently running (if any).
- AOV bands across the file.
- Discount frequency and discount tolerance of the brand.

If recency-based segmentation is not already happening, fixing the segmentation is the first move. Single-bucket "all lapsed customers" treatment leaves 50–70% of the achievable revenue on the table.

## Procedure

### 1. Pull lapsed customer count by recency band

If `modern-mcp` is connected:

```
modern.retention.lapsed_count(
  buckets=["90_180_days", "180_365_days", "365_730_days", "730_plus_days"],
  as_of="<today>"
)
```

Otherwise ask the user to share or estimate the count in each band. Even rough numbers are sufficient to scope the opportunity.

### 2. Pull last-purchase recency distribution and historical AOV

If `modern-mcp` is connected:

```
modern.retention.last_purchase_recency(
  as_of="<today>",
  granularity="weekly",
  include_aov=true,
  include_purchase_count=true
)
modern.sales.aov(
  start_date="<24 months ago>",
  end_date="<today>",
  group_by="cohort"
)
```

Otherwise ask for the distribution shape and approximate AOV by band. High historical AOV customers warrant different treatment than low historical AOV customers.

### 3. Pull existing winback flow performance

If `modern-mcp` is connected:

```
modern.flows.revenue_by_flow(
  start_date="<6 months ago>",
  end_date="<today>",
  flow_type=["winback", "reactivation", "lapsed_offer"]
)
```

Otherwise ask which winback flows are currently running, what offers they use, and per-flow conversion / revenue per recipient.

### 4. Build the lapse-segment table

Cross recency band with historical AOV and purchase count. Compute approximate addressable revenue per segment (count × historical AOV × expected reactivation rate). The numbers will reveal where to focus.

### 5. Apply the recency-based offer ladder framework

Match offer intensity to recency. Light-lapsed customers get content; deep-lapsed get incentives; dead customers get one final touch and then dropped from active sends.

### 6. Apply do-not-contact rules before sending

Filter the lapsed list against the do-not-contact criteria below before any winback campaign launches.

## Framework: lapse-segment taxonomy

The four canonical segments, each warranting different treatment:

**Light-lapsed (90–180 days since last purchase).** Customers who are slightly off their normal cadence but not gone. Many are simply mid-cycle on a replenishment they have not finished yet. Reactivation rate here is the highest of any segment — often 15–30% with a light nudge. Crucially: do not lead with a discount. A hard discount to light-lapsed customers trains the brand's regular buyers to lapse intentionally for the discount.

**Deep-lapsed (180–365 days).** Customers who have meaningfully fallen out of the pattern. Some have switched competitors; some have just lost the habit. Reactivation rate drops to 5–15% but the marginal customer is still recoverable. Discount becomes appropriate here, but should be tied to a new product reveal or category extension rather than a generic comeback offer.

**Dead-lapsed (365–730 days).** Customers who have not purchased in a year or more but who still respond to email. Reactivation rate drops to 2–8%. Email engagement metrics matter: customers who have opened or clicked any email in the last 90 days are recoverable; customers who have not are mostly gone.

**Cold-lapsed (730+ days).** Customers who have not purchased in two years and who show no email engagement. Reactivation rate under 1%. Sending to this segment damages list health more than it produces revenue. Drop from active sends; suppress from paid retargeting.

The segment definitions assume monthly-or-faster replenishment categories. For longer-cycle categories (electronics, furniture, fashion seasonal), shift the bands upward (180 / 365 / 730 / 1095+).

## Framework: recency-based offer ladder

The offer ladder matches incentive intensity to recency. The principle: do not waste a hard discount on a customer who would have come back on their own.

| Segment | Touch 1 | Touch 2 | Touch 3 |
|---|---|---|---|
| Light-lapsed | "We miss you" / new content / no discount | Light incentive (free shipping or AOV-conditional 10%) | Personal-touch email (founder or support) |
| Deep-lapsed | New product reveal at full price | New product + 15% off | Hard offer (20–25% off, time-bounded) |
| Dead-lapsed | One reactivation campaign with hard offer (20–30% off) | If no engagement, suppress | — |
| Cold-lapsed | Suppress immediately, no touches | — | — |

The ladder is constructed so that each segment receives the lightest sufficient touch first. Hard discounts are reserved for segments where lighter touches will not work. Brands that lead with hard discounts to all lapsed customers train their customer file to lapse for the discount, which damages full-price conversion long-term.

## Framework: channel mix for winback

Email is the primary winback channel across all segments. SMS and paid retargeting layer in selectively.

**Email.** Default channel for all segments. Carries the offer, the new-product reveal, and the personal touch. Performance scales with subject-line quality and reply-to legitimacy.

**SMS.** Layer in for light-lapsed and deep-lapsed customers who have opted in to SMS, especially if AOV is high (over \$80). Do not collect SMS purely to send winback. Conversion rate is 2–4x email but list size is much smaller.

**Paid retargeting.** Reserve for deep-lapsed customers as a wakeup layer. Light-lapsed do not need it; cold-lapsed should not be retargeted (wasted spend). The right structure: 7-day retargeting window after a winback email send, frequency capped at 4 impressions, with explicit suppression of any customer who has opened or clicked the email.

**Direct mail.** Niche but high-impact for high-AOV deep-lapsed customers. A physical postcard with a hand-signed note from the founder converts deep-lapsed at 3–5% — often outperforming email at this segment. Cost-effective only for AOV above \$120 and lapsed populations above 5,000.

**Phone outreach.** Reserved for very high-AOV customers (over \$500 historical AOV) in deep-lapsed segment. Personal outreach from a customer success rep, not a sales call. Conversion rates 8–15%. The economics support it only for the top of the customer file.

## Framework: repurchase-intent prediction signals

Not all lapsed customers are equally likely to repurchase. Layering intent signals on top of recency segments improves campaign efficiency substantially.

**Browse behavior.** Customers who have visited the site in the last 30 days but not purchased are higher-intent than recency alone suggests. Tag them and prioritize.

**Email engagement.** Customers opening but not clicking are warming up. Customers clicking but not buying are intent-positive. Customers neither opening nor clicking for 6+ months are likely lost.

**Support tickets.** Customers with recent support interactions (even complaints, particularly resolved ones) are higher-intent than silent customers. Loop support data into winback segmentation.

**Wishlist / favorite behavior.** Customers maintaining wishlists or favorites are intent-positive even without recent purchases.

**Referral activity.** Customers who have referred others, even in the past, retain higher reactivation rates. They are advocates whose own purchasing has lapsed.

The intent overlay turns a recency-only segmentation into a recency × intent matrix. Customers in 180–365 day lapse but high-intent (recent browse + email engagement) often outperform 90–180 day light-lapsed customers with no intent signals. Allocate winback budget to the matrix, not just the recency axis.

## Framework: do-not-contact rules

Before any winback campaign launches, filter against:

- **Refund history.** Customers who have requested refunds — particularly multiple refunds — should not receive a winback campaign. The previous transaction did not work; reactivation without addressing the cause damages brand perception.
- **Quality complaint flags.** Customers who left a low rating or filed a complaint should not be re-engaged with a generic winback. If the brand has resolved the complaint, a personal apology email is appropriate; a discount-led blast is not.
- **NPS detractors.** Customers who scored the brand 6 or lower on NPS should be excluded from broad winback. They may be re-engaged with a "we'd love your feedback" email but not with a discount blast.
- **Unsubscribe / list-cleanup signals.** Customers who unsubscribed from any flow should not be re-included in winback. This includes hard-bounce and spam-complaint history.
- **Active customer of a competing brand under the same parent.** Cross-brand portfolios sometimes accidentally re-engage customers active elsewhere in the portfolio. Filter against the cross-brand active list.

These rules are not just brand hygiene; they are protective of list health. Sending to suppressed populations elevates spam complaint rates, which lowers inbox-placement scores for the entire list. The cost of one bad winback campaign extends to every subsequent send.

## Framework: tenure-weighted offer ladder

High-tenure customers warrant softer offers; low-tenure customers warrant harder offers.

The logic: a customer who bought from the brand twice over six months and has now lapsed at 180 days has lower lifetime affinity than a customer who bought eight times over two years and has now lapsed at 180 days. The latter customer is more likely to reactivate with a soft touch; the former needs more incentive.

Practically:

- 4+ orders historical + 180–365 day lapse → soft touch (content, no discount).
- 4+ orders historical + 365+ day lapse → mid touch (10–15% off, new product reveal).
- 1–3 orders historical + 180–365 day lapse → mid touch.
- 1–3 orders historical + 365+ day lapse → hard touch (20%+ off, then suppress if no response).

The tenure overlay is the second axis on top of recency. Combined with the intent overlay, the customer file segments into a 3D matrix. Brands above 10,000 lapsed customers should manage all three axes; brands below can simplify to recency + tenure.

## Output Format

Structure the response in this order:

1. **Lapse landscape diagnosis.** One sentence on the segment distribution and where the highest-value addressable revenue sits.
2. **Lapse-segment table.** Each segment with count, AOV, addressable revenue at expected reactivation rate.
3. **Suppression audit.** Estimated count of customers who should be excluded from winback per the do-not-contact rules.
4. **Quick Wins.** 2–4 changes shippable this week, usually segment-specific flow design or list hygiene.
5. **High-Impact Changes.** 2–3 changes over 4–6 weeks, usually building the recency × intent × tenure matrix and the channel-mix architecture.
6. **Test Ideas.** 2–3 controlled tests with primary metric, holdout size, duration.
7. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `subscription-churn` — when winback candidates are actually cancelled subscribers and the right intervention is upstream of the lapse.
- `repeat-purchase` — for the 30–90 day window before light-lapsed treatment begins.
- `cohort-retention` — when winback opportunity is being driven by cohort-quality decline upstream.
