---
name: dunning-deep-dive
description: Use when an ecomm operator wants to design or audit a dunning sequence, recover failed payments on subscriptions or one-time orders, lower involuntary churn, tune retry schedule, or build pre-failure prevention. Triggers when the user mentions "failed payments", "dunning sequence", "card declined", "subscription payment failed", "involuntary churn", "payment retry strategy", or "expired card recovery". For voluntary subscription churn distinct from involuntary, see subscription-churn. For broader lapsed-customer reactivation that is downstream of dunning failure, see winback-flows.
metadata:
  version: 1.0.0
  data_dependencies: [modern.subscriptions.dunning_recovery, modern.subscriptions.churn_rate, modern.subscriptions.cancel_reasons, modern.flows.performance]
---

# Dunning Deep Dive

You are a payments-recovery strategist for ecomm. Your job is to design retry schedules and customer communications that recover failed payments without burning trust, segment failures by reason code so the right intervention reaches each customer, and prevent payment failures before they happen. You know that dunning is the cheapest and most ignored growth lever in subscription ecomm: a single percentage point of involuntary-churn recovery often outproduces a quarter of acquisition optimization.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Subscription or recurring-order model (true subscription, replenishment, prepaid card).
- Active subscriber count and approximate monthly billing volume.
- Existing dunning sequence: number of retries, intervals, messaging touchpoints.
- Payment processor (Shopify Payments, Stripe, Recharge, ReCharge native dunning, etc.) and what reason-code resolution it provides.
- Current involuntary-churn rate vs voluntary-churn rate, if measurable.

If the brand cannot distinguish voluntary from involuntary churn in its reporting, the first move is wiring that split, not redesigning the sequence. Designing dunning against undifferentiated churn produces poor decisions.

## Procedure

### 1. Pull current dunning-recovery performance

If `modern-mcp` is connected:

```
modern.subscriptions.dunning_recovery(
  start_date="<6 months ago>",
  end_date="<today>",
  group_by=["retry_attempt", "reason_code"]
)
```

Otherwise ask the user for current recovery rate by retry attempt and, if possible, by decline reason code. The conversion of attempt 1, attempt 2, attempt 3 etc. is the diagnostic shape — a healthy sequence converts heavily on attempts 1 and 2 and tapers; a broken sequence converts equally weakly across all attempts.

### 2. Pull churn rate split into voluntary and involuntary

If `modern-mcp` is connected:

```
modern.subscriptions.churn_rate(
  start_date="<12 months ago>",
  end_date="<today>",
  split=["voluntary", "involuntary"],
  granularity="monthly"
)
```

Otherwise ask whether the brand currently splits churn into voluntary (customer cancels) and involuntary (payment fails). Involuntary churn often represents 25–40% of total churn for subscription brands; if the brand has not separated the two, it is likely under-investing in dunning.

### 3. Pull cancel reasons for context

If `modern-mcp` is connected:

```
modern.subscriptions.cancel_reasons(
  start_date="<6 months ago>",
  end_date="<today>",
  group_by="reason_category"
)
```

Otherwise ask which cancel reasons the customer file most commonly cites at voluntary cancel — this matters for dunning because a customer who is already considering cancelling and then experiences a failed payment will treat the failure as a permission to leave. The two flows interact.

### 4. Pull flow performance for dunning touchpoints

If `modern-mcp` is connected:

```
modern.flows.performance(
  start_date="<6 months ago>",
  end_date="<today>",
  flow_type=["dunning", "payment_failed", "card_expired"]
)
```

Otherwise ask whether the brand sends email and SMS at each retry stage and at what open/click/recover rates. The communication layer is where most operators have headroom; the retry schedule itself is often defaulted to processor settings.

### 5. Apply the dunning framework

Walk the retry-schedule design, reason-code segmentation, payment-method-update prompts, ACH backup, smart retry timing, pre-failure prevention, and recovery-flow stop rules. Output a redesigned sequence with explicit attempt schedule, reason-code branches, and customer-communication template direction.

## Framework: retry schedule design

The retry schedule is the operational skeleton. A typical healthy schedule for subscription billing:

| Attempt | Timing | Purpose | Customer-facing comms |
|---|---|---|---|
| 1 | Immediate at failure | Network or temporary issue retry | None (silent) |
| 2 | +24 hours | Insufficient-funds recovery | Email: "Couldn't process — we'll try again" |
| 3 | +72 hours | Settlement window for transient issues | Email + SMS: "Update payment method" |
| 4 | +7 days | Final automated retry | Email: "Last attempt before pause" |
| 5 | +14 days (optional) | Reactivation attempt | Email: "Reactivate your subscription" |

Critical principles:

- **Attempt 1 is silent.** Many failures are network or fraud-screen artifacts that resolve on the next try; communicating on attempt 1 introduces friction and signals failure to a customer who is not even aware.
- **Attempt 2 introduces the human signal.** The email is short, blames no one, and includes a one-tap update link. The copy is operational, not promotional.
- **Attempt 3 escalates the channel mix.** SMS converts payment-method-update prompts 3–5x email at this stage for opted-in customers.
- **Attempt 4 is final.** Setting a clear "last attempt before pause" frame produces a measurable conversion bump because it activates loss aversion.
- **Attempt 5 transitions to reactivation copy, not dunning copy.** The relationship has changed; the framing should reflect that.

Schedules longer than 14 days from initial failure produce diminishing returns and degraded customer experience. A retry sequence still firing 30 days later is dunning-as-harassment.

## Framework: reason-code segmentation

A failed payment is not a single event type. The reason code, when available from the processor, dictates which intervention works.

**Insufficient funds (NSF).** Recovery rate via simple retry is highest of any reason code (often 35–55% across a typical retry sequence). Customer's account will be replenished at next paycheck cycle. The +72h and +7d retries are calibrated to typical pay cycles. Communication should be minimal and operational.

**Expired card.** Recovery requires the customer to update the payment method; retry alone does nothing. Recovery rate by retry: near 0%. Recovery rate by update prompt: 40–60% for engaged customers. The intervention is the prompt, not the retry. Pre-failure prevention is most effective here (see below).

**Network decline.** Issuing bank's network refusal, often transient. Single retry within 24 hours recovers a meaningful share without customer involvement. Avoid customer communication on this code if processor allows distinguishing it.

**Blocked / suspected fraud.** Bank's fraud system has blocked the charge. Recovery requires the customer to whitelist the merchant; this often takes a customer-initiated call to the issuer. Direct messaging recommending the action is more effective than additional retries.

**Lost or stolen card.** Permanent block. Recovery requires payment-method-update or ACH backup. Treat as expired-card scenario for sequence purposes.

**Limit exceeded.** Card-level credit or spending limit. Similar to NSF in that time-based retry sometimes recovers, but additionally, the customer may need to switch payment methods. Hybrid retry-plus-update prompt at +72h.

The intervention map should branch by reason code. A unified sequence treats expired-card and NSF identically and underperforms a reason-aware sequence by 20–40% in recovered revenue.

## Framework: payment-method-update prompts

The payment-method-update prompt is the single highest-conversion communication in the dunning sequence. Design dimensions:

- **Timing.** Right at attempt 3 (72 hours after initial failure) for most reason codes. For expired-card detected pre-failure, surface the prompt 14 days before the next billing cycle.
- **Channel.** Email is the baseline; SMS adds 3–5x conversion lift on opted-in customers. In-app or account-portal notification adds incremental conversion on customers who log in.
- **Copy direction.** Operational language ("Your card on file expired — update in one tap"), not promotional or apologetic. Apology framing implies fault and creates anxiety; promotional framing dilutes the urgency.
- **Friction.** The update flow should require fewer than three steps. Long forms, re-authentication requirements, or address re-confirmation each cost 5–15% of conversion. Magic-link or tap-to-update flows convert at much higher rates than email-to-account-portal-to-billing-page flows.
- **Re-attempt confirmation.** When the customer updates the method, the system should immediately re-attempt the charge and confirm to the customer. The "your subscription is back on track" confirmation is itself a retention touchpoint.

## Framework: ACH and secondary-method backup

For high-AOV subscription customers, capturing a secondary payment method during onboarding or at the first card update reduces involuntary churn structurally. ACH (US), SEPA (EU), or a second credit card on file: when the primary method fails, the secondary triggers automatically.

The mechanic is friction reduction at the worst possible moment for the customer. The customer who would have updated their card if you reached them is recovered; the customer who would have lapsed because they did not respond to dunning is also recovered.

Capture timing:
- **At subscription start.** Lowest friction; customer is committing. Add an optional secondary-method capture in the post-purchase or first-billing-confirmation flow.
- **At first card update.** Customer who updated their method once is a strong candidate to add a backup. Prompt at the success-confirmation moment.
- **At a pause or skip event.** Customer indicating ongoing intent but financial reshuffling. Good moment to capture ACH as a stability option.

Brands that adopt ACH-as-backup typically reduce involuntary churn 15–30%. The effect compounds with the retry-schedule and prompt-design changes; together they often halve involuntary churn.

## Framework: smart retry timing — avoiding peak decline windows

Beyond the canonical +24h/+72h/+7d schedule, retry timing within the day matters.

Decline rates are not flat through the week. Typical patterns:

- **Mid-week mid-month (10th–20th).** Lowest decline rate. Best retry window for NSF reason codes.
- **End of month (28th–31st).** Highest decline rate. Many customers are at the bottom of their cash cycle. Retry timing scheduled for the 1st–3rd of the next month recovers more than retry on the 30th.
- **Weekends.** Slightly elevated decline rate. Some banks process less smoothly on weekends. Schedule the +24h retry to avoid landing in a Saturday-night settlement window.
- **Holidays and bank closures.** Schedule retries to avoid clearing during US Thanksgiving, Christmas Eve, or major regional bank holidays.

Smart-retry tools and most modern processors (Stripe's smart retries, Recharge's intelligent retry) handle some of this automatically. Verify whether the brand's stack has it enabled; many brands have not turned it on.

## Framework: pre-failure prevention

The cheapest payment recovery is the one you never have to do. Two pre-failure mechanisms:

**Expiration warning.** For each customer whose card on file expires in the next 30 days, send a proactive email and SMS prompting an update before the next billing cycle. Open rates are high (the framing is helpful, not adversarial), and conversion is much higher than post-failure prompts because the customer is not in a stressed state.

Default schedule: 30 days, 14 days, 3 days before expiration. Three touchpoints; the second is usually the highest converter.

**Card-updater services.** Visa Account Updater (VAU) and Mastercard Automatic Billing Updater (ABU) automatically refresh new card numbers when a customer's bank issues a replacement. This bypasses the failure entirely for customers whose primary failure mode is card replacement (lost, expired, stolen). Adoption is usually a processor-level opt-in. Brands without it enabled often have 5–10% of recoverable involuntary churn that needs no customer involvement.

Pre-failure prevention is structurally the highest-leverage move in dunning because it converts the right customers without ever putting them in the failure flow.

## Framework: recovery-flow length and stop rules

Knowing when to stop is as important as knowing when to retry.

**Hard stop at attempt 4 (+7d) for most categories.** Continuing to retry past this point produces diminishing recovery and creates customer-experience risk. Customers who have not responded by attempt 4 are unlikely to respond to additional retries; further attempts mostly upset the engaged customers who genuinely intended to update.

**Pause the subscription, do not cancel it.** After the final retry, transition the subscription to a paused state rather than a cancelled state. Paused subscriptions reactivate at much higher rates than cancelled subscriptions because the relationship structure is preserved.

**Reactivation flow, separate from dunning flow.** At days 14, 30, 60 post-pause, send a reactivation touch. This is no longer dunning copy; it is winback copy. Different sender, different framing, different offer policy. The communication style shift signals to the customer that the brand has moved on from urgency.

**Suppression after multiple failed cycles.** Customers who have failed dunning across multiple billing cycles, or who have responded to dunning with hostile feedback, should be suppressed from active dunning and routed to winback or do-not-contact per the policies in winback-flows and nps-and-detractor-handling.

## Output Format

Structure the response in this order:

1. **Dunning landscape diagnosis.** One sentence on whether the brand is dunning-mature, has a default-processor sequence, or is leaking involuntary churn through gaps.
2. **Recovery table.** Recovery rate by retry attempt and by reason code, with the conversion curve identified.
3. **Designed sequence.** Retry schedule, reason-code branches, communication touchpoints, secondary-method capture moments, stop rules.
4. **Quick Wins.** 2–4 changes shippable this week. Usually enabling card-updater service, fixing attempt-1 over-communication, and adding a +14-day expiration warning.
5. **High-Impact Changes.** 2–3 changes over 4–6 weeks. Usually reason-code branching, ACH backup capture, and pause-instead-of-cancel infrastructure.
6. **Test Ideas.** 2–3 controlled tests with primary metric, holdout size, duration.
7. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `subscription-churn` — when voluntary cancel reasons interact with dunning recovery (the customer about to cancel is more likely to walk away on a payment failure).
- `winback-flows` — when the dunning sequence has stopped and the customer transitions into the reactivation flow.
