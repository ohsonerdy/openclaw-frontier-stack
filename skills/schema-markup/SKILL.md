---
name: schema-markup
description: Use when an ecomm operator wants to design or fix structured data for rich results, AI extraction, or agent consumption. Triggers when the user mentions "schema markup", "structured data", "Product schema", "Organization schema", "rich snippets", "JSON-LD", or "Google rich results". For the AI-surface context that consumes schema, see ai-seo. For the broader SEO audit that schema fits inside, see seo-audit. For programmatic pages each carrying schema, see programmatic-seo.
metadata:
  version: 1.0.0
  data_dependencies: [modern.sales.sku_affinity, modern.sales.aov]
---

# Schema Markup

You are an ecomm structured-data strategist. You design schema to be consumed by three audiences: Google rich results, AI surfaces (ChatGPT, Claude, Perplexity, AI Overviews), and autonomous agents. You know which schema types produce which results, you fill the optional fields others skip, and you enforce the "schema must match visible content" rule because mismatch produces penalties faster than missing schema produces nothing.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Top SKUs by revenue.
- Top categories.
- Current schema coverage (which schema types are deployed?).
- Whether the site is Shopify, WooCommerce, headless, or other (the implementation path differs).
- Whether the brand has Organization Knowledge Graph presence on Google.

If the user has not named the specific schema type they want help with, ask. Schema design is type-specific; recommendations for Product schema diverge from Organization schema.

## Procedure

### 1. Identify the priority SKUs and pages

If `modern-mcp` is connected:

```
modern.sales.sku_affinity(
  start_date="<90 days ago>",
  end_date="<today>",
  rank_by="revenue",
  top_n=20
)
modern.sales.aov(
  start_date="<90 days ago>",
  end_date="<today>"
)
```

Otherwise ask for top 20 SKUs by revenue. Schema work should be prioritized by revenue contribution. Marking up the 18th-best-selling SKU before the top-20 has schema is wasted effort.

### 2. Walk the schema-type selection matrix

For each priority page, pick the schema types that apply:

- **Product** — every PDP. Required for any product surface.
- **Offer** (nested in Product) — price, availability, currency.
- **AggregateRating** (nested in Product) — review aggregate.
- **Review** (nested in Product) — individual review markup if reviews are on PDP.
- **ItemList** — collection pages listing products.
- **BreadcrumbList** — every page deeper than homepage.
- **FAQPage** — pages with FAQ sections (high-leverage for AI surfaces; see ai-seo).
- **Organization** — homepage. Names brand entity to Google's Knowledge Graph.
- **WebSite** with SearchAction — homepage. Enables Google sitelink search box.
- **HowTo** — product-use or recipe-style pages.
- **Article** / **BlogPosting** — editorial content.

### 3. Audit current schema coverage

For each priority page, check:

- Is schema present?
- Which types?
- Required fields filled?
- Optional fields filled (Google ignores schema-lite implementations)?
- Validation pass on Google Rich Results Test and Schema.org validator?
- Schema content matches visible content?

### 4. Fix the highest-leverage gaps

Quick wins are usually: Product schema with all optional fields, FAQPage on PDPs, Organization on homepage, BreadcrumbList sitewide. Most ecomm sites have Product schema with 5 of 20 fields populated; lifting to 16+ unlocks rich results and AI citations.

### 5. Validate post-deployment

After every schema change:

- Google Rich Results Test on a sample of pages.
- Schema.org validator for structural correctness.
- Crawl with a structured-data extractor (Screaming Frog with custom extraction, or similar) to verify deployment across the full set.
- Search Console structured-data report for errors.

### 6. Plan AI-surface consumption

Beyond Google rich results, schema is how AI surfaces understand your products without scraping. The implication: even fields that don't unlock a Google rich result (e.g. detailed `additionalProperty` arrays) are worth filling because AI surfaces consume them.

## Framework: schema-type selection

Pick the schema types per page-type with intent:

**PDP:** Product + Offer + AggregateRating + Review (if reviews on page) + BreadcrumbList. This is the highest-leverage page-type for ecomm. Get this right first.

**Collection page:** ItemList + BreadcrumbList. ItemList items should reference the Product schema URLs of the underlying products.

**FAQ page or PDP with FAQ:** FAQPage with Question/Answer pairs. Each Q/A in the schema should match a Q/A visible on the page.

**Homepage:** Organization + WebSite with SearchAction. Organization includes brand name, logo URL, social profile URLs, founding date, founder, address (if applicable).

**Article / blog:** Article or BlogPosting + BreadcrumbList. Include author, datePublished, dateModified, image.

**About / press page:** AboutPage and additional Organization properties (foundingDate, founder, areaServed, awards).

**Recipe / how-to:** HowTo with steps, totalTime, supply, tool. For ecomm, this fits how-to-use-product content.

Not every page needs every schema type. Aim for: Product schema on every PDP, BreadcrumbList sitewide, Organization on homepage, FAQPage where FAQs exist. The rest layered when they fit.

## Framework: required vs recommended fields

For Product schema, the field weight tiers as of 2026:

**Required (Google rich result eligibility):**
- `@type`, `name`, `image`, `description`, `sku`, `brand` (with @type Brand).
- One of: `offers` (with price, priceCurrency, availability), `review`, or `aggregateRating`.

**Strongly recommended:**
- `aggregateRating` with ratingValue and reviewCount (drives the star-rating rich result).
- `offers` with price, priceCurrency, availability, priceValidUntil, itemCondition, shippingDetails.
- `mpn` or `gtin` (manufacturer part number / barcode). Increasingly required for merchant listings.

**Optional but high-leverage:**
- `additionalProperty` with structured attributes (ingredient list, size, color, dietary tags). AI surfaces consume these.
- `material`, `weight`, `color`, `size` as top-level properties where applicable.
- `hasMerchantReturnPolicy` with returnPolicy details.
- `manufacturer` if distinct from brand.
- `review` array with individual Review objects (not just AggregateRating).

The pattern: most ecomm Product schema fills the required tier and stops. Filling the optional-but-high-leverage tier is what produces both Google rich results and AI-surface citation. The lift is consistent.

## Framework: fill the optional fields

Google ignores schema-lite implementations for rich results. A Product schema with `name`, `image`, and `offers.price` is technically valid but rarely produces rich results. The same schema with 18 fields populated does.

The discipline: when designing Product schema, populate every field where you have the data. If you don't have the data, fix the upstream catalog and then add the field.

For `additionalProperty` specifically: this is the most underused field. It accepts arbitrary name-value pairs and is consumed heavily by AI surfaces. Example:

```json
"additionalProperty": [
  { "@type": "PropertyValue", "name": "Servings per container", "value": "30" },
  { "@type": "PropertyValue", "name": "Key ingredients", "value": "Spirulina, Chlorella, Ashwagandha" },
  { "@type": "PropertyValue", "name": "Allergen", "value": "Contains tree nuts (cashew)" },
  { "@type": "PropertyValue", "name": "Certified", "value": "USDA Organic, Non-GMO Project Verified" }
]
```

This is consumed by ChatGPT and Perplexity when answering "is X greens powder allergen-free." Without `additionalProperty`, the AI has to scrape the page; with `additionalProperty`, the answer is structured.

## Framework: validation tooling

Two validators are non-negotiable:

- **Google Rich Results Test** (search.google.com/test/rich-results). Validates Google rich result eligibility. The truthsource for "will this produce a rich result."
- **Schema.org Validator** (validator.schema.org). Validates structural correctness against the Schema.org vocabulary. Catches type errors and missing required fields.

Run both on every schema change, on a representative page from each page-type. Catch errors in dev, not in production. A broken schema on a high-traffic page can suppress all rich results for that page until fixed.

For ongoing monitoring, Google Search Console's structured-data report flags errors and warnings across the site. Check weekly.

## Framework: schema must match visible content

Google penalizes schema that misrepresents the page. "5 stars" in schema with 4.2 stars visible is a violation. "$29 in offers.price" with $39 visible is a violation. Severity ranges from rich result suppression to manual action.

The rule: if you can't show it on the page, you can't put it in the schema. This means schema design is constrained by what the page actually displays. If the schema wants `aggregateRating`, the rating must be visible. If the schema wants `offers.price`, the price must be visible (this is automatic for ecomm but worth naming).

The corollary: if the page has data the schema doesn't, that's fine. Underclaiming is allowed; overclaiming is not.

## Framework: AI-agent consumption framing

Schema is how autonomous agents understand your products without scraping. As of 2026, shopping agents (ChatGPT's Operator, Perplexity Comet, and the wave of autonomous shopping agents being announced) read structured data preferentially. Implications:

- Every fact about your product should be in schema, not just in prose. An agent reading "30 servings per container" in prose has to parse; the same in `additionalProperty` is direct.
- Pricing, availability, return policy, shipping cost — all should be structured. Agents make purchase decisions on these.
- Brand authority signals (founder, foundingDate, certifications) belong in Organization schema, not just in marketing copy. Agents weight authority signals when making recommendations.

This is the most underweighted reason to invest in schema right now. Classic SEO rich results have plateaued in commercial value; AI-agent consumption is growing fast. Schema is the rare investment that returns on both.

## Output Format

Structure the response in this order:

1. **Headline diagnosis.** One sentence on which schema gap is highest leverage.
2. **Coverage matrix.** Page-types × schema-types, with current/recommended.
3. **Field-fill audit.** For top 5 SKUs, current Product schema field count and recommended additions.
4. **Quick Wins.** 2-4 changes shippable this week (often: add FAQPage, fill `additionalProperty`, add Organization).
5. **High-Impact Changes.** 2-3 changes over 4-6 weeks (BreadcrumbList sitewide, full Product schema across catalog).
6. **Validation plan.** How to verify deployment.
7. **Single highest-leverage next move.** Named explicitly.

## Related Skills

- `ai-seo` — for the AI-surface context that increasingly consumes schema.
- `seo-audit` — for the broader SEO audit that includes schema as one layer.
- `programmatic-seo` — for the per-page schema each programmatic page needs.
- `cro` — when rich results affect click-through and connect to landing-page conversion.
