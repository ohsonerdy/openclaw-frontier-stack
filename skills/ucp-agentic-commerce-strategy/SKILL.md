---
name: ucp-agentic-commerce-strategy
description: Use when designing, scoping, or reviewing a product, module, or skill that touches the Universal Commerce Protocol (UCP) — the open standard co-developed by Google and Shopify for agentic commerce. Triggers when the user mentions "UCP", "Universal Commerce Protocol", "agentic commerce", "Shopify Catalog MCP", "Google AI Mode shopping", "Gemini shopping", "Microsoft Copilot Checkout", "agent readiness score", "brand visibility for AI shopping", "Shopify Global Catalog", or "what do AI shopping agents see". The skill enforces five design constraints derived from Shopify and Google primary documentation, so that scoping work doesn't drift into non-compliant or factually wrong territory. For schema design that touches the storage layer, see schema-design. For broader product-marketing positioning of the resulting offering, see product-marketing-positioning. For a security/threat pass on the agent profile, see threat-modeling.
metadata:
  version: 0.1.0
---

# UCP agentic commerce strategy

UCP — the Universal Commerce Protocol, co-developed by Google and Shopify and announced January 11 2026 — is one protocol family, not two adjacent stacks. Every product or skill that proposes to "show merchants how AI shopping agents see them" lives or dies on whether its authors correctly model UCP. Most first-draft proposals get this wrong in roughly the same five ways.

This skill codifies the corrections so the next proposal doesn't repeat them. It is operator-safe: it cites only public Shopify and Google documentation and does not assume any private integration beyond the standard merchant-authorized Modern AI MCP connection.

For schema and storage decisions implied by the constraints, see schema-design. For positioning the resulting product to a merchant audience, see product-marketing-positioning. For evaluating the trust-tier exposure of the proposed UCP agent profile, see threat-modeling.

## When to use this skill

- Drafting or reviewing a product brief that promises visibility into AI shopping surfaces.
- Scoping a connector list for an OpenClaw module that talks to Shopify Catalog MCP or any UCP-aligned surface.
- Designing storage or "diff over time" patterns for catalog observations.
- Choosing what review-related signal a competitive-intelligence product can promise.
- Reviewing an agent profile or trust-tier decision before publishing it to Shopify.
- Auditing a teammate's brief for factual drift from primary Shopify or Google docs.

## The five design constraints

Each constraint has a primary-source citation and a concrete decision rule. When a teammate proposes work in this space, walk the proposal through all five.

### 1. UCP is one protocol, not two adjacent stacks

**Primary source:** https://www.shopify.com/news/ai-commerce-at-scale (Shopify newsroom, 2026-01-11).

The announcement is unambiguous: UCP is *"a new open standard co-developed with Google to bring commerce to agents at scale."* The same announcement names Microsoft Copilot Checkout, Google AI Mode in Search, and the Gemini app as UCP client surfaces managed through Shopify Agentic Storefronts.

**Decision rule:** When a teammate proposes a connector list, the right shape is:

- One UCP catalog connector (covers Google AI Mode, Gemini, Microsoft Copilot, Shopify's own surfaces via the shared protocol).
- One consumer-surface observer (presentation-level, not protocol-level — for "what does AI Mode *say back* to a user").
- One merchant-authorized review-platform connector (only if the product needs review content beyond aggregate rating).

Never split UCP into separate "Shopify UCP" and "Google Shopping" halves. They are the same protocol. Google's Shopping Graph is the broader index Google maintains; the agent-facing protocol shape sitting on top of that index is UCP.

### 2. Scope agent-surface promises to UCP-covered surfaces

**Primary source:** https://www.shopify.com/news/ai-commerce-at-scale and https://shopify.dev/docs/agents.

UCP-covered consumer surfaces, as of May 2026:

- Google AI Mode in Search
- Gemini app
- Microsoft Copilot Checkout
- Shopify's own surfaces (Shop app, Agentic Storefronts admin)

Not UCP-native, as of May 2026:

- ChatGPT — runs on a separate OpenAI protocol. A Shopify-side bridge exists via Agentic Storefronts admin, but the underlying protocol and catalog feed are different from UCP.
- Claude — no consumer transactional shopping surface comparable to AI Mode / Gemini / Copilot Checkout. A developer using Claude with MCP can shop programmatically, but that is not a consumer commerce channel.

**Decision rule:** If a brief promises visibility into ChatGPT or Claude as "AI shopping agent surfaces," push back. Those need different protocols and different data paths. Either drop them from v1 scope or route them through a separately scoped non-UCP connector.

### 3. Catalog MCP exposes aggregate rating, not review text

**Primary source:** https://shopify.dev/docs/agents/catalog/mcp.

The documented response shape for `search_global_products` and `get_global_product_details` includes:

```
"rating": { "value": 4.8, "count": 124 }
```

That is the entirety of the review-related surface. No review text, no positive themes, no negative themes, no buyer language, no defect descriptions, no "wish it had" quotes, no shipping complaints. Other rich fields (`uniqueSellingPoint`, `topFeatures`, `techSpecs`, `sharedAttributes`) are Shopify-AI-inferred per the *"Inferred fields"* note in https://shopify.dev/docs/agents/catalog and must be surfaced to merchants as inferred, not authoritative.

**Decision rule:** Any workflow that depends on review text, themes, objections, defect patterns, or buyer vocabulary requires a separate merchant-authorized review-platform connector — Yotpo, Judge.me, Stamped, Okendo, Trustpilot, Reviews.io, etc. The merchant authorizes the connection through their Modern AI MCP integration (see "Modern AI MCP merchant-authorization layer" below). If the proposed integration with the review platform is not in scope for the release, the review-content workflow must be cut from that release, not silently promised.

### 4. Catalog results and product images cannot be cached

**Primary source:** https://shopify.dev/docs/agents/catalog — "Usage guidelines" section. Direct quotes:

> *"Don't cache or re-use images: Images may only be used in connection with the related merchant's product listing and must be rendered in real-time (not downloaded to servers)."*
>
> *"Don't cache search results: Catalog results reflect merchant preferences on pricing, availability, and presentation. Caching results isn't allowed."*

**Decision rule:** Storage proposals must respect three rules:

- Persist only normalized or derived observations (scores, deltas, flags, computed metrics). Never raw catalog response payloads. Never raw images.
- For diff-over-time patterns, compare against persisted normalized observations or aggregate metrics, never against a cached upstream payload. Where a current snapshot is needed, re-fetch.
- A receipts table is allowed and encouraged, but receipts hold *timestamp + connector + URL + content hash + run ID only*. Not payloads. The hash proves what was observed without retaining the data.

If a teammate proposes a `*_products` or `*_reviews` table that holds raw catalog or review payloads, that is a non-compliance issue, not a stylistic preference. Either rescope the table to merchant-authorized own-catalog data with explicit retention authorization, or cut it.

### 5. UCP agent profile and trust tier is a design constraint, not an open question

**Primary source:** https://shopify.dev/docs/agents and the Global Catalog MCP reference at https://shopify.dev/docs/agents/catalog/global-catalog.

Every Global Catalog MCP request must include a `meta.ucp-agent.profile` URL pointing to the agent's published UCP profile. Returned tools depend on the capabilities the agent advertises, and Shopify enforces rate limits and tool access against trust tiers. A competitive-intelligence agent that never transacts will land in the lowest trust tier — that's the design floor, not a runtime surprise.

**Decision rule:** Before any UCP-touching brief leaves draft, the brief must commit to:

- The UCP profile shape the OpenClaw connector will publish (URL, profile category).
- The capabilities advertised (typically: read-only catalog discovery, no transactional checkout, no cart creation).
- The expected throughput envelope per merchant client, sized to fit inside the lowest trust tier's published rate limits.
- Whether concurrent merchants run as separate UCP agent identities or share a single profile (separate identities only where merchant authorization is in place).

If the brief still phrases the trust-tier question as "TBD" or "an open question," that is a gating issue — kick it back for resolution before the brief ships.

## Modern AI MCP merchant-authorization layer

Where a UCP-adjacent product needs merchant-authorized data — own-catalog retention, review-platform connections, private storefront data — the authorization path is the merchant connecting their store to the product through the standard Modern AI MCP integration. Concretely:

- The merchant authenticates against their Shopify store through Modern AI MCP.
- That authentication is what lets the product persist normalized observations of the *merchant's own* catalog beyond a single run.
- For competitor data, even with the merchant's authorization for *their* store, the product can only persist *derived* metrics (e.g., "competitor X had N variants in stock as of timestamp T") — not the underlying catalog payload.
- For review-platform data (Yotpo / Judge.me / Stamped / Okendo / Trustpilot / Reviews.io), the merchant's authorization for their own review-platform account, brokered through Modern AI MCP, is what makes the connection compliant. Competitive use of another merchant's review-platform data is generally not on offer.

This pattern keeps the data path compliant: every persisted record either has merchant authorization (own data) or is a derived metric (no upstream payload retained).

## Common mistakes

Each mirrors one of the audit findings the skill is designed to prevent.

1. **Treating UCP and Google Shopping as separate connectors.** Symptom: a connector list with both `shopify_ucp_catalog` and `google_shopping_visibility` as parallel data paths. Fix: collapse to one UCP catalog connector. Google AI Mode and Gemini ride UCP.
2. **Promising ChatGPT or Claude visibility through a UCP-grounded product.** Symptom: a value-prop sentence like "see how your brand appears in ChatGPT, Claude, Gemini, AI Mode, Copilot." Fix: scope to UCP-covered surfaces (AI Mode, Gemini, Copilot Checkout, Shopify's own). Move the others to a separately scoped non-UCP track if there is appetite for them.
3. **Building a review-content workflow on top of UCP.** Symptom: a Review Intelligence section that extracts positive themes, objections, defect clusters, buyer vocabulary from "the agentic commerce surface." Fix: scope review content to a merchant-authorized review-platform connector. Until that connector ships, the product reports aggregate `rating: { value, count }` only.
4. **Caching catalog payloads or images.** Symptom: a `*_products` or `*_observations` table that stores "raw response hash" alongside the actual response payload, plus a "daily monitoring" workflow that does diff against cached results. Fix: normalize at ingest, discard the raw payload, store only the normalized fields plus a receipt (timestamp + URL + content hash, no payload). Re-fetch for current comparisons.
5. **Leaving UCP agent profile / trust tier as an open question.** Symptom: an "Open Questions" section that includes "Which UCP trust tier is required for richer catalog fields?" Fix: pick the lowest trust tier (the only one a non-transacting CI agent can credibly publish), commit to a profile shape, define the capabilities advertised, and size the throughput envelope to the lowest-tier rate limit.

## Decision checklist for UCP-touching briefs

When asked to review a brief or proposal in this space, walk through these eight questions in order. Any "no" routes back to the author for revision.

1. Does the brief treat UCP as one protocol whose consumer surfaces include AI Mode, Gemini, Copilot Checkout, and Shopify's own surfaces?
2. Is the agent-surface list limited to UCP-covered surfaces — with ChatGPT and Claude either dropped or routed through a separately scoped non-UCP track?
3. Are review-content workflows either cut from the release or gated behind a merchant-authorized review-platform connector?
4. Is every persisted table either (a) normalized/derived metrics only, (b) merchant-authorized own-catalog data with explicit retention authorization, or (c) receipts (timestamp + URL + content hash, no payload)?
5. Is there no "diff against cached catalog payloads" pattern anywhere? Does diff-over-time operate on persisted normalized observations, with re-fetches for current snapshots?
6. Does the brief commit to a specific UCP agent profile, capability set, and throughput envelope at the lowest trust tier?
7. Does the merchant-authorization story go through the Modern AI MCP connection rather than ad-hoc credentials?
8. Are primary sources from Shopify and Google cited directly (Shopify newsroom, Shopify dev docs, Google developer blog) rather than via secondary coverage?

## Citations the skill enforces

When reviewing or authoring a brief, these are the primary URLs to cite. Use the exact URLs — do not paraphrase or substitute secondary sources.

- Shopify announcement (UCP, January 11 2026): https://www.shopify.com/news/ai-commerce-at-scale
- Shopify UCP marketing: https://www.shopify.com/ucp
- Shopify Engineering UCP: https://shopify.engineering/ucp
- Shopify agents docs root: https://shopify.dev/docs/agents
- Shopify Catalog overview (Usage guidelines source): https://shopify.dev/docs/agents/catalog
- Shopify Catalog MCP reference (rating shape source): https://shopify.dev/docs/agents/catalog/mcp
- Shopify Global Catalog MCP: https://shopify.dev/docs/agents/catalog/global-catalog
- Google UCP technical post: https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/
- UCP spec hub: https://ucp.dev/documentation/core-concepts/

## Related skills

- `schema-design` — the storage shape that follows from the no-cache rule. UCP storage decisions are a specific application of the general schema-design discipline.
- `product-marketing-positioning` — how to position a UCP-grounded product against existing GEO/AEO tools (Profound, Peec) and existing competitive-intel tools (Particl, Charm.io, Shoplift). The category is not greenfield.
- `threat-modeling` — apply STRIDE to the proposed UCP agent profile before publishing, especially around the data-handling assertions in the profile.
- `architecture-decision-records` — capture the UCP-related decisions (connector shape, storage shape, trust tier commitment) as ADRs so future contributors can see why the shape is what it is.
- `api-design` — when designing the surface OpenClaw exposes to merchant clients on top of the UCP integration, the general API design discipline applies.
