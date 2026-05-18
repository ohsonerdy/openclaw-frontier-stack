# Modern AI Context — <your-brand-name>

> **What this file is:** the per-tenant context that every Modern Skill reads at
> the start of its run. It captures the brand voice, ICP, product catalog, ad
> channels, and KPI targets the skills need to ground their analysis in YOUR
> business — not generic ecomm.
>
> **Where it lives:** drop this file at `.agents/modern-ai-context.md`
> relative to your project root (or working directory when running a skill).
> Modern AI's onboarding flow can generate and update it automatically once
> connected; this file is the manual fallback template.
>
> **Update cadence:** review monthly, refresh after major product changes,
> ad-channel additions, or pricing changes.
>
> Replace every placeholder (in angle brackets) with your real values.
> Lines starting with `>` are guidance and can be deleted.

Last updated: <YYYY-MM-DD>
Modern AI org: <your-modern-ai-org-slug>

---

## Brand

**Voice:** <2–3 sentences describing tone. Example: "Confident, calm, technical.
We sound like the smartest operator in the room — never breathless, never
gimmicky, never apologetic. Lean toward shorter sentences and concrete nouns.">

**Tone do:** <comma-separated list. Example: specific, evidence-led, plain English,
short sentences>

**Tone don't:** <comma-separated list. Example: hype, jargon, exclamation marks,
"game-changer", "revolutionary", "rockstar", "ninja">

**Always:** <list — e.g. capitalize product name "X"; use "customers" not "users">

**Never:** <list — e.g. use the word "AI" in marketing copy; reference competitor
names; promise specific ROI numbers>

---

## ICP (Ideal Customer Profile)

### Primary

<one paragraph describing the primary customer — role, company size, industry,
budget band, pain trigger. Example: "Heads of growth at $5M–$50M ARR DTC brands
that have hit a wall on Meta ROAS and are exploring channel diversification
without losing the unit economics they built on paid social.">

**Pain points:**
- <list 3–5 specific pains>

**Buying triggers:**
- <what causes them to actively shop for a solution>

**Decision criteria:**
- <how they evaluate vendors>

### Secondary (optional)

<repeat the same structure for a secondary ICP, if you serve more than one>

---

## Product catalog

> Auto-synced from your Shopify (or equivalent) store when the Modern AI MCP is
> connected. Manual override below if you want to highlight specific SKUs to
> Modern Skills.

**Catalog source:** <Shopify | WooCommerce | BigCommerce | manual>

**Top SKUs by revenue (last 90d):**
- `<sku-id-or-name>` — <category> — <margin band: low/medium/high>
- `<sku-id-or-name>` — <category> — <margin band>
- `<sku-id-or-name>` — <category> — <margin band>

**Top subscription SKUs (if applicable):**
- `<sku-id>` — <plan cadence: monthly/quarterly/annual> — <ARPU band>

**Bundles currently live:**
- `<bundle-name>` — composition: <SKU 1 + SKU 2 + SKU 3> — <attach rate band>

**Hero products** (your flagship SKUs — get extra emphasis in CRO/copy skills):
- `<sku-id>`
- `<sku-id>`

---

## Channels

### Active paid

| Channel | Monthly spend band | Target ROAS | Current ROAS |
|---|---|---|---|
| Meta (Facebook + Instagram) | <e.g. $50k–$150k/mo> | <e.g. 3.5> | <last-90d actual> |
| Google Ads | <band> | <target> | <actual> |
| TikTok Ads | <band> | <target> | <actual> |
| <other> | | | |

### Active organic

- <e.g. SEO — primary, 30% of new acquisition>
- <e.g. Email — primary retention channel>
- <e.g. Affiliate / referral — secondary>
- <e.g. Organic social — brand, low direct acquisition>

### Top email flows

> Flow performance auto-pulls from Klaviyo via the MCP when connected. List
> the flow NAMES here so skills know what your taxonomy is.

- <Welcome series>
- <Cart abandonment>
- <Browse abandonment>
- <Post-purchase>
- <Replenishment / winback>
- <Subscription save flow>

---

## KPIs

**Revenue band (monthly):** <e.g. $500k–$1M MRR>

**Blended CAC target:** <e.g. $45>

**Blended CAC last 90d:** <actual>

**LTV target (180-day window):** <e.g. $180 — implies LTV:CAC of 4>

**Repeat purchase rate target (30-day):** <e.g. 18%>

**Subscription churn target (monthly):** <e.g. <5% voluntary>

**Margin target (post-discount):** <e.g. 55% blended>

**Anomaly thresholds** (when should skills proactively flag?):
- Channel ROAS drop > <e.g. 25% week-over-week>
- Repeat-rate drop > <e.g. 15% month-over-month>
- Subscription churn spike > <e.g. 30% month-over-month>

---

## Do-not-contact rules

> Skills like `winback-flows`, `cart-abandonment-recovery`, and
> `subscription-churn` consult this list before suggesting outreach.

**Hard exclusions** (never market to these segments):
- NPS detractors (score ≤ 6) within the last 90 days
- Customers with an active refund/dispute
- Anyone who unsubscribed from marketing email
- Customers flagged with `do_not_contact: true` in your CRM

**Soft exclusions** (suppress from acquisition-style messaging, OK for transactional/service):
- Customers whose last support ticket is unresolved
- Customers in active dunning flow

---

## Notes for Modern Skills

> Free-form section. Anything that doesn't fit the structured fields above but
> a skill would benefit from knowing. Examples:

- <e.g. "We're testing a B2B wholesale channel — pause B2C-flavored messaging
  for the `wholesale@` customer segment.">
- <e.g. "Pricing increase Q3 — all new winback copy should reference the
  pre-increase price they paid as the anchor.">
- <e.g. "Inventory constrained on SKU-1234 for the next 6 weeks — don't push
  it as a hero product until further notice.">

---

*This file is read by Modern Skills at the start of every invocation. Keep it
current. The skills' recommendations are only as good as the context they have.*
