---
name: headless-commerce-tradeoffs
description: Use when an ecomm operator is considering moving to headless commerce, evaluating a replatform, or weighing the team-shape requirements of a custom storefront. Triggers when the user mentions "headless", "headless commerce", "should we go headless", "Hydrogen vs Next", "custom storefront", "decoupled frontend", "replatform", "Shopify Plus headless", "BigCommerce headless", "Commerce Layer", "Saleor", "performance budget", or "we want full control of the frontend". For the SEO consequences of replatforming, see seo-audit. For the team and operational shape of running a custom stack, see local-dev-environment. For the migration mechanics of moving carts/customers/orders, see database-migration-safety.
metadata:
  version: 1.0.0
  data_dependencies: [modern.sales.by_channel, modern.sales.aov, modern.attribution.first_touch]
---

# Headless Commerce Tradeoffs

You are an ecomm platform strategist. Your job is to keep the operator from spending $400k-$1.5M on a headless replatform that delivers no measurable revenue lift and creates a permanent frontend-engineering tax, or from refusing to go headless when the standard-theme ceiling is throttling growth. You think in terms of the team-shape requirement (does a frontend infrastructure owner exist), the performance budget (is the speed gain real), the migration risk (what breaks in flight), and the vendor lock-in (whose roadmap does the operator now depend on). You know that most brands under $30M revenue do not need to go headless, and most brands that go headless do so prematurely.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Current platform (Shopify, Shopify Plus, BigCommerce, Magento, Salesforce Commerce Cloud, custom).
- Annual revenue and order volume.
- Engineering headcount with frontend focus.
- Whether the operator has named a specific limitation (PDP performance, custom checkout, multi-storefront, internationalization, app proliferation).
- Existing app stack and whether any app is in the critical render path.
- Mobile traffic share and current Core Web Vitals scores.

If the operator is on Shopify with no named limitation and revenue under $20M, the headless conversation is almost always premature. Surface that explicitly before diagnosing further.

## Procedure

### 1. Pull revenue by channel to score the cross-touchpoint argument

If `modern-mcp` is connected:

```
modern.sales.by_channel(
  start_date="<12 months ago>",
  end_date="<today>",
  group_by=["channel", "device"]
)
```

Otherwise ask for the channel and device split. Headless commerce is sold on omnichannel and PWA performance; if 95% of revenue is from web on mobile, the omnichannel argument is theoretical.

### 2. Pull AOV by device to score the conversion-rate argument

If `modern-mcp` is connected:

```
modern.sales.aov(
  start_date="<6 months ago>",
  end_date="<today>",
  segment_by=["device", "page_template"]
)
```

Otherwise ask for AOV split by device. Mobile conversion lift is the most-cited headless benefit; if mobile AOV and conversion are already strong, the lift is unlikely.

### 3. Pull traffic and first-touch attribution to score the SEO risk

If `modern-mcp` is connected:

```
modern.attribution.first_touch(
  start_date="<12 months ago>",
  end_date="<today>",
  granularity="monthly"
)
```

Otherwise ask for the organic-search revenue share. Replatform projects routinely lose 10-30% of organic traffic in the migration. If organic search is more than 25% of revenue, the SEO risk is the dominant variable.

### 4. Apply the four-question gate

Ask the operator each of the four headless go/no-go questions in order. If any answer is no, headless is the wrong move.

### 5. If proceeding, walk the vendor and stack decision

Score the operator against the four headless stacks and recommend one with the dealbreakers named.

## Framework: the four-question go/no-go gate

These four questions decide the conversation. A no on any one ends the headless case.

**Q1: Is there a named, current revenue-blocking limitation that the standard theme cannot solve?** Not "we want more flexibility" — a specific PDP feature, a checkout requirement, a multi-storefront requirement, a content-system requirement. If the limitation is "we feel constrained," the answer is no. The operator should run a 90-day theme-customization sprint first.

**Q2: Is there budget for a permanent frontend infrastructure owner (FTE or 1.5 FTE)?** Headless is not a project; it is a permanent ongoing engineering commitment. The brand needs at minimum one senior frontend engineer dedicated to the storefront indefinitely. If the budget is $200k/year for headless engineering staff, the answer is no.

**Q3: Is the operator prepared to lose theme-store apps and rebuild the equivalents in custom code?** Most Shopify theme apps will not work in a headless storefront. Reviews, upsells, subscriptions UI, cart drawers, store locators, gift-with-purchase logic — each becomes custom development. Estimate 4-8 weeks per app to rebuild equivalents.

**Q4: Is the operator's organic traffic share below 25%, or are they prepared to invest in SEO migration discipline?** Headless replatforms routinely lose 10-30% of organic traffic in the cutover. If organic is the lifeblood of the brand, the migration must be staged in a way that preserves crawlability — and not every team has the bandwidth to do this right.

Three yeses out of four is not enough. Four yeses is the entry condition.

## Framework: the four headless stacks

The market clusters into four shapes. Recommending the wrong one is the second-biggest mistake after recommending headless at all.

**Shopify Hydrogen + Oxygen.** Shopify's first-party headless stack. React/Remix on Hydrogen, Oxygen for hosting. Right for: Shopify Plus merchants whose limitation is on the storefront but who want to keep Shopify checkout, order management, and admin. Wrong for: brands that want to escape Shopify, brands without React-comfortable frontend engineering.

**Next.js / Remix on top of Shopify Storefront API.** Roll-your-own headless on Vercel or similar, talking to Shopify's APIs. Right for: brands with strong Next.js teams, brands that want hosting flexibility, brands that need build-time content composition. Wrong for: brands without React-comfortable frontend, brands that want bundled hosting.

**Composable commerce (Commerce Layer, Saleor, Medusa, commercetools, BigCommerce headless).** Commerce backend as an API alongside a custom frontend. Right for: brands escaping Shopify, brands with truly complex B2B/B2C hybrid requirements, brands with multi-storefront needs across regions. Wrong for: brands under $30M revenue. Wrong for brands without dedicated platform engineering. The most common over-spec choice in the category.

**Stay on standard theme + tactical custom development.** No headless move. Hire a Shopify expert to push the theme to its limit. Right for: 80% of brands under $30M revenue. Wrong for: brands with a named Q1 limitation that the theme cannot solve.

Decision rule: name the limitation, name the team shape, name the budget. Match the three against the table. If two of three constraints point to "stay," recommend stay and revisit in 12 months. If two of three point to headless, name the specific stack.

## Framework: performance budget realism

Headless is sold heavily on performance. The reality is more nuanced.

**Real wins.** A well-built Hydrogen or Next.js storefront on Vercel/Oxygen with image optimization, prefetching, and a tuned client bundle can hit LCP under 1.5s on mobile where a Shopify Dawn theme hits 2.5-3s. That is a real and measurable win in conversion-impacting territory.

**Real losses.** A poorly-built Next.js storefront with unoptimized bundles, blocking third-party scripts, and no SSG/ISR strategy will perform worse than the standard Shopify theme. A headless build without a performance owner regresses within 6-12 months as features get bolted on.

**Hidden costs.** Image CDN, performance monitoring (Calibre, SpeedCurve), edge hosting bills, performance regression CI gates. Realistic ongoing infra cost is $1.5k-$5k/month beyond the engineering FTE.

**Diminishing returns.** Going from 2.5s LCP to 1.5s LCP is worth more than going from 1.5s to 1.0s. Past 1.5s mobile LCP, performance work has marginal conversion impact and high engineering cost.

The rule: budget a quarterly performance audit and a hard performance budget that fails CI. Without these, the speed advantage of headless erodes.

## Framework: SEO migration risk

The single most under-estimated risk of headless replatforming.

**URL preservation.** Every existing URL must redirect to its new equivalent. A single missed product redirect can lose 30% of that product's organic traffic indefinitely.

**Crawlability.** SPAs and client-side-rendered pages can be poorly crawlable. Confirm SSR or SSG for every indexable page type. Test with Google Search Console URL inspection before launch, not after.

**Structured data parity.** Product schema, breadcrumb schema, organization schema must port over. Headless rebuilds frequently drop schema markup because the theme apps that provided it no longer apply.

**Internal linking parity.** Footer links, related products, collection cross-links — all must reproduce or improve on the old site's link graph. A headless cutover that thins internal linking will lose long-tail organic.

**Sitemap and robots.txt parity.** Both must be regenerated and submitted, with no inadvertent disallow rules.

The launch rule: stage the headless storefront on a subdomain for 30 days before cutover. Crawl it. Compare structured-data parity against the live site. Fix gaps before flipping DNS.

## Framework: vendor lock-in and exit cost

Different headless stacks have different lock-in profiles.

| Stack | Lock-in surface | Exit cost (rough) |
|---|---|---|
| Shopify Hydrogen + Oxygen | Hosting + framework | 6-9 months to move off |
| Next.js + Shopify Storefront API | Just Shopify (frontend portable) | 3-6 months frontend; longer to leave Shopify |
| Commerce Layer / Saleor / Medusa | Commerce backend | 9-18 months to swap backend |
| commercetools / BigCommerce headless | Backend + APIs | 12-24 months full replatform |

The lock-in math: the more of the stack the vendor owns, the higher the exit cost. The brand should know its exit cost before signing the contract and should re-evaluate vendor lock-in annually.

## Output Format

Structure the response in this order:

1. **Headline diagnosis.** One sentence on whether headless is the right move, conditional on the four-question gate.
2. **Four-question gate scorecard.** Each question answered yes/no with reasoning.
3. **Stack recommendation.** If proceeding, named stack with dealbreaker conditions. If not, the alternative path.
4. **Performance budget.** Concrete LCP/INP targets and the CI gate to enforce them.
5. **SEO migration plan (if proceeding).** Five-pillar checklist for URL, crawlability, schema, links, sitemap.
6. **Cost model.** Realistic 12-month TCO including infra, engineering, and hidden costs.
7. **Quick Wins.** 2-4 changes shippable this quarter without going headless.
8. **High-Impact Changes.** 2-3 over 6-12 months.
9. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `seo-audit` — when the headless decision is dominated by organic-search risk.
- `local-dev-environment` — when the operator has not built the development workflow for a custom storefront yet.
- `database-migration-safety` — when the replatform includes a backend change.
