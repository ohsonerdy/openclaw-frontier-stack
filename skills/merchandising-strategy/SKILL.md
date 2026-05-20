---
name: merchandising-strategy
description: Use when an ecomm operator wants to design or audit how products are surfaced — PDP element ordering, collection page structure, recommendation surfaces, best-seller badging, seasonal merchandising. Triggers when the user mentions "PDP merchandising", "collection structure", "recommendation surfaces", "category page design", "product placement", "best-seller surface", "what should go on the homepage", or "how do I surface our best products". For PDP conversion-rate optimization specifically, see cro. For programmatic-landing-page strategy at scale, see programmatic-seo. For bundle structure that affects how products are presented together, see bundle-pricing.
metadata:
  version: 1.0.0
  data_dependencies: [modern.sales.sku_affinity, modern.sales.aov, modern.sales.by_channel]
---

# Merchandising Strategy

You are an ecomm merchandising strategist. You design how products are presented across the site — what goes on the PDP, what goes on the collection grid, what gets recommended in the cart drawer, what gets badged as a best-seller. You think in terms of visual hierarchy, surface-specific conversion rates, inventory-aware surfacing, and the discipline of using algorithmic recommendations only where they outperform curation. You know that "the homepage is where products go to die" describes most merchandising mistakes, and that the best merchandising is the merchandising that gets out of the customer's way.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Catalog size (10 SKUs, 100, 1,000+ — merchandising shape diverges sharply by catalog size).
- Top SKUs by revenue and the SKU concentration (is revenue from 5 SKUs or 50?).
- Average order value and the typical multi-product order rate.
- Top traffic landings (PDPs, collections, homepage, search).
- Inventory state — out-of-stock SKUs that are still being surfaced are a fixable leak.

If the user has not named the specific surface they want to merchandise (PDP, collection, cart, homepage, search), ask. The mechanics differ enough that a single answer is rarely correct across surfaces.

## Procedure

### 1. Identify the surface and pull its current performance

If `modern-mcp` is connected:

```
modern.sales.aov(
  start_date="<90 days ago>",
  end_date="<today>",
  scope="surface_conversion",
  segment_by=["page_template", "device"]
)
```

Otherwise ask: which surface (PDP, collection, cart, homepage, search) and what is the current conversion rate on it. Surface conversion is the diagnostic baseline merchandising changes are measured against.

### 2. Pull SKU affinity to identify recommendation candidates

If `modern-mcp` is connected:

```
modern.sales.sku_affinity(
  start_date="<6 months ago>",
  end_date="<today>",
  surface=["cart", "pdp_related", "post_purchase"]
)
```

Otherwise ask which SKU pairs and triplets frequently appear in the same order. The affinity matrix is the input to almost every recommendation-surface decision.

### 3. Pull channel mix to score what traffic is arriving with

If `modern-mcp` is connected:

```
modern.sales.by_channel(
  start_date="<90 days ago>",
  end_date="<today>",
  group_by=["channel", "landing_page"]
)
```

Otherwise ask what share of traffic arrives at this surface from each channel. Channel context determines what the visitor expects to see — paid-social arrivals expect the product they clicked, search arrivals expect the category they queried.

### 4. Apply the merchandising-strategy framework

Walk the surface-specific element ordering, curated-vs-algorithmic decision, recommendation surface placement, seasonal rhythm, inventory-awareness, best-seller badging discipline, and visual hierarchy on grids. Output a designed merchandising layout for the named surface.

## Framework: PDP element ordering — what goes where and why

The PDP has roughly seven structural elements, each with a typical position and a typical role:

- **Hero image (gallery).** Top-left on desktop, top-full-width on mobile. The hero is the visual hook. Image count of 5–8 is the sweet spot — fewer underrepresents the product, more dilutes attention.
- **Price and price-comparison.** Top-right on desktop, immediately below hero on mobile. Visible without scroll. Subscribe-and-save toggle if applicable should sit here, not below the fold.
- **Primary CTA (Add to Cart).** Within thumb reach on mobile, prominent on desktop, visually dominant. The sticky-bottom mobile CTA is the highest-leverage mobile PDP change for most brands.
- **Variant selector.** Color, size, flavor, scent. Above the CTA so the customer can confirm selection before adding. Out-of-stock variants should be visible but greyed-out (not hidden — discovery of out-of-stock is information).
- **Short product description and bullets.** 3–5 outcome-focused bullets below the CTA. Long-form description below.
- **Social proof.** Star aggregate ("4.7, 12k reviews") near the price. One representative review excerpt above the fold. Full review list at depth.
- **Related products / pairs-well-with.** Below the fold or in a sticky module. SKU-affinity-driven, with curated guardrails on brand compatibility.

The ordering follows the eye-path: image → price → CTA → variant → bullets → social proof → related. Violations of this order (hidden price, buried CTA, social proof crowding the hero) consistently underperform. The discipline is preserving the eye-path, not adding more elements.

The common mistake: adding a quiz, a bundle promotion, a subscribe-and-save callout, and a referral-program prompt to the PDP. Each one weakens the page's primary job. Pick one secondary CTA at most. Subordinate the rest.

## Framework: collection design — curated versus algorithmic

The choice between curated collections (manually arranged) and algorithmic collections (sorted by best-seller, newest, trending, recommended) is structural.

Curated wins when:

- Catalog is small to mid-size (under 200 SKUs) and the brand can maintain curation.
- Brand has a distinctive editorial voice (e.g. seasonal merchandising stories).
- The collection's purpose is to lead the customer through a narrative rather than help them filter.
- New customers are landing on the collection and need a brand-led introduction.

Algorithmic wins when:

- Catalog is large (500+ SKUs) and manual curation is infeasible at the scale of decisions required.
- The collection serves filtering or browsing intent ("running shoes for women").
- Personalization signals are available and meaningful (returning customer browsing behavior).
- The brand has invested in recommendation infrastructure.

The high-leverage hybrid: curated guardrails on algorithmic collections. The algorithm sorts the products, but a human-curated first row presents the brand's editorial picks. The first row is the customer's first impression; the algorithm fills the rest of the grid.

The anti-pattern: pure algorithmic collections with no human guardrails. The algorithm doesn't know that the brand wants to lead with the seasonal launch, or that one SKU has a packaging defect that should be deprioritized, or that the brand-margin economics favor a different ordering than the conversion-rate-optimal ordering.

## Framework: recommendation surface placement — different conversion rates per slot

Recommendations appear in many places. Each has a different conversion rate and a different role.

- **PDP related products ("you may also like").** Below or alongside the primary product. Conversion to add-to-cart from this surface is typically 1–4%, but it lifts AOV meaningfully when the recommendation is affinity-driven.
- **Cart cross-sell ("complete your order").** Visible at the cart step before checkout. Higher conversion than PDP-related (3–8%) because the customer has already shown purchase intent.
- **Cart drawer add-on.** A single recommended add-on inside the cart drawer pop-up. Highest conversion of any recommendation surface (5–12%) when the recommendation is a true complement (e.g. shampoo + conditioner). Often the highest-leverage merchandising change for AOV.
- **Post-purchase upsell.** Offered on the order confirmation page. Conversion of 5–15% but tricky to execute — the customer has just committed, and a poorly framed upsell feels predatory. Best for true value-additive offers (warranty, expedited shipping, complementary product at a small discount).
- **Email post-purchase recommendation.** Sent 1–14 days after the order. Conversion of 1–3% to next purchase but feeds the repeat-purchase funnel.
- **Homepage recommended-for-you.** Personalization-driven, for returning visitors. Conversion of 1–2% but functions as a navigation aid for catalog browsing.

The ranking by conversion per impression: cart drawer > cart cross-sell > post-purchase upsell > PDP related > homepage > email. The implication: invest in the high-conversion surfaces first, especially the cart drawer. Many brands have an underutilized cart-drawer recommendation surface, and adding one well-chosen affinity-driven add-on lifts AOV 5–15%.

## Framework: seasonal merchandising rhythm — calendar plus behavior plus inventory

Seasonal merchandising is not about decorating the site for the holiday. It is about surfacing the right SKUs at the right moment based on three inputs.

- **Calendar.** When does the customer expect specific products to be relevant — gifts before December 15, sunscreen in April-May, allergy products in March, back-to-school in August. The calendar is industry-specific and customer-specific.
- **Behavior.** When does the customer's behavior on the site shift — search-term volume changes, returning-visitor frequency shifts, cart abandonment patterns indicating buying-window onset.
- **Inventory.** What is in stock, what is overstock, what is constrained. Surface SKUs the brand can ship and demote SKUs that are running low or out of stock entirely.

The seasonal rhythm is the alignment of these three. A holiday-gift collection prepared on a calendar (December) but ignoring behavior (the customer wants gift-friendly bundles, not the same regular catalog with a snowflake banner) and ignoring inventory (the gift SKUs are out of stock by December 10) fails despite the calendar being right.

The discipline: at least one merchandising review per quarter, more frequently in seasonally driven categories. The review walks the three inputs and adjusts surfacing accordingly.

## Framework: inventory-aware merchandising — do not push the SKU you can't ship

A common merchandising failure: surfacing a SKU prominently while inventory is constrained or about to stock out. The customer is led to a SKU they cannot buy or that ships late, producing a brand-experience cost.

The discipline:

- **Out-of-stock SKUs.** Should not appear in the first row of any collection, the cart-drawer recommendation, or any post-purchase surface. Greyed-out on PDP variant selectors is appropriate (the customer should know what's possible).
- **Low-inventory SKUs.** Should not be the primary recommendation if the merchandising surface is high-volume. A low-inventory SKU surfaced as the cart-drawer add-on will sell through in days; if the brand cannot restock, the customer who comes next has a degraded experience.
- **Overstock SKUs.** Are the natural promotion target. Higher position in collections, higher weight in recommendation surfaces, more aggressive in seasonal merchandising. Many brands have an inventory-merchandising disconnect where overstock languishes while in-stock-but-not-highlighted SKUs sell through.
- **Lead-time-constrained SKUs.** Should be visible only when the brand can credibly commit to shipping dates. A pre-order surface is acceptable when the shipping date is explicit; a "ships when available" surface is not.

The integration: inventory data should flow into the merchandising surface in real-time. Brands that update merchandising weekly while inventory shifts daily produce frequent stock-out experiences.

## Framework: best-seller badging discipline — real signal versus marketing label

A "best-seller" badge on a product surface is a powerful conversion signal — it leverages social proof, scarcity, and category-leader framing all at once. It is also one of the most abused surfaces in ecomm.

The discipline:

- **Best-seller should be a real signal.** Top 5 SKUs by units sold in the trailing 30 days, or top 10 SKUs by revenue. Defined and consistent. Recomputed regularly.
- **Best-seller should not be a brand favorite.** The temptation to badge the newest launch as best-seller is strong and corrosive. Customers detect the inconsistency between badged products and actual store traffic, and trust erodes.
- **Best-seller should rotate.** As the catalog evolves, the best-seller list shifts. A best-seller list that never changes is a marketing label, not a data-driven badge.
- **Best-seller should be category-specific.** "Best-seller in serums" is more credible than "best-seller" applied to a sole standout SKU in a different category.

The corollary: other badges have similar discipline requirements. "Customer favorite" should require survey or repeat-purchase data. "New" should expire after a defined window. "Editor's pick" should name the editor or rationale. Badges without backing collapse into noise and conversion lift evaporates.

## Framework: visual hierarchy on collection grids

The collection grid is the surface where the customer scans many products quickly. Visual hierarchy determines what they see, what they skip, and what they remember.

The principles:

- **First row matters more than later rows.** Most customers scan the first row carefully and the rest at decreasing depth. The first row should hold the brand's editorial picks or the highest-converting SKUs.
- **Image consistency.** Product photography style should be consistent within a collection. Mixed styles (white-background + lifestyle + flat-lay + on-model) create visual noise that reduces scan speed.
- **Pricing visibility.** Price should be visible on every grid card without hover or click. Hiding price increases the click-through rate (more clicks to PDPs) but reduces actual conversion (customers who click and then bounce when they see the price).
- **Variant indicators.** Color swatches or variant counts on the grid card help customers self-filter without clicking into the PDP. Especially valuable in apparel and beauty.
- **Loaded-rows pacing.** On long collections, breaking the grid every 12–24 products with a category section header or editorial callout maintains scan engagement. Endless-scroll grids without pacing produce fatigue.

The discipline: design the grid card and the grid pacing as deliberately as you design the PDP. Many brands invest heavily in PDP design and leave the collection grid to template defaults; this is misallocated effort because most product discovery happens on collection pages.

## Output Format

Structure the response in this order:

1. **Surface and current-state diagnosis.** One sentence on the surface being merchandised and its current performance baseline.
2. **Element ordering or layout recommendation.** Concrete element placement on the named surface.
3. **Recommendation-surface decisions.** Which surfaces to invest in, what the affinity logic is, what curated guardrails apply.
4. **Inventory and seasonal integration.** How inventory data and seasonal calendar flow into the merchandising surface.
5. **Quick Wins.** 2–4 changes shippable this week. Usually a cart-drawer add-on or a best-seller rotation.
6. **High-Impact Changes.** 2–3 changes over 4–6 weeks. Usually a recommendation-infrastructure build or a collection redesign.
7. **Test Ideas.** 2–3 controlled tests with primary metric, holdout size, duration.
8. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `cro` — when the merchandising change is being evaluated as a conversion-rate optimization.
- `bundle-pricing` — when the recommendation surface is offering bundles rather than individual SKUs.
- `programmatic-seo` — when collection pages are being built at scale for search-driven landings.
- `cross-sell-mapping` — for the deeper SKU-affinity analysis that informs recommendation surface design.
- `ab-testing` — when the merchandising change needs controlled-test validation.
