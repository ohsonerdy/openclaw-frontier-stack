# Modern Skills — Integration Spec

**Audience:** engineering team building the plugin
**Companion to:** README.md (user-facing setup) and YORU-HANDOFF.md (release process)

This doc covers what "directly integrated" means for the skills ↔ MCP wiring. The README tells users how to connect. This tells the implementers how to make the skills actually use the connection.

Plugin name: `modern-skills`. Publisher: Modern AI. Display name: "Modern Skills."

---

## Architecture

```
User's agent (Claude Desktop / Code / Codex / Cursor)
        │
        ├── Plugin: modern-ai/modern-skills
        │     skills/<name>/SKILL.md  (40+ marketing skills)
        │     scripts/validate-skills.sh
        │     evals/evals.json per skill
        │
        └── MCP: modern-mcp
              command: npx -y mcp-remote https://mcp.modern.ai/mcp
              auth:    Authorization: Bearer <api-key>
              tools:   modern.* (sales, ads, attribution, retention)
```

When the agent loads a skill that needs live data, the skill's procedure text references specific `modern.*` MCP tool calls. The agent invokes them; the MCP returns the data; the skill applies its framework.

---

## Skill-to-MCP wiring convention

Every skill in the plugin follows the same template for data sections. The template has three parts:

### Part 1: Context check (always)

```markdown
## Initial Assessment

Check for `.agents/modern-ai-context.md` (the tenant context file generated
by Modern AI's onboarding). If present, read it before asking the user
anything that file already answers: brand voice, ICP, top SKUs, ad accounts,
attribution model, monthly revenue band.
```

### Part 2: Data acquisition (conditional on MCP)

```markdown
## Procedure

1. If `modern-mcp` is connected, pull <specific dataset> via:
       modern.<domain>.<tool>(<params>)
   Otherwise, ask the user for the data.

2. ...
```

Each skill names its required MCP tools by full identifier. The agent resolves them at runtime. No code generation, no template engine — the skill text is the contract.

### Part 3: Framework application (always)

```markdown
3. Apply <skill-specific framework>...
4. Output recommendations in the standard sections: Quick Wins,
   High-Impact Changes, Test Ideas.
```

The framework runs on either real data (when MCP is connected) or user-supplied data (when it isn't). Skills are MCP-aware but not MCP-required.

---

## Required MCP tool surface

This is the surface the Modern Skills depend on. Modern AI MCP must expose these tool names for the integration to work end to end. Tool naming follows `modern.<domain>.<verb>_<noun>`.

> **⚠️ Open item for Modern AI eng:** I have inferred this surface from the README quickstart questions. Confirm against the actual MCP schema at `https://mcp.modern.ai/mcp` (run a `tools/list` request) and reconcile any naming differences. If a tool name needs changing, change it in this doc AND in the affected skills — skills name tools by literal identifier.

### Organizations & metadata

| Tool | Returns |
|---|---|
| `modern.org.list` | Array of orgs the API key holder belongs to |
| `modern.org.connected_sources` | Connected data sources for the active org (Shopify, Meta, GA4, etc.) |

### Sales & revenue

| Tool | Returns |
|---|---|
| `modern.sales.net_sales` | Net sales for a date range, optionally grouped by day/week/month |
| `modern.sales.by_channel` | Revenue split by acquisition channel |
| `modern.sales.aov` | Average order value over a date range |
| `modern.sales.new_vs_returning` | New vs returning customer revenue mix |

### Advertising

| Tool | Returns |
|---|---|
| `modern.ads.spend` | Ad spend by channel/campaign for a date range |
| `modern.ads.roas` | ROAS by channel/campaign |
| `modern.ads.cac_by_channel` | Blended and per-channel CAC |
| `modern.ads.payback_period` | Days to recover CAC by channel |

### Attribution

| Tool | Returns |
|---|---|
| `modern.attribution.first_touch` | First-touch attribution by channel |
| `modern.attribution.last_touch` | Last-touch attribution by channel |
| `modern.attribution.multi_touch` | Multi-touch model output |

### Retention

| Tool | Returns |
|---|---|
| `modern.retention.repeat_rate` | N-day repeat purchase rate |
| `modern.retention.cohort_ltv` | LTV by acquisition cohort and window |
| `modern.retention.cohort_survival` | Cohort survival curve |
| `modern.retention.churn_rate` | Voluntary and involuntary churn |

### Email / flow performance

| Tool | Returns |
|---|---|
| `modern.flows.revenue_by_flow` | Revenue attributable per Klaviyo (or equivalent) flow |
| `modern.flows.performance` | Open / click / conversion rates per flow |

### Anomaly / summary

| Tool | Returns |
|---|---|
| `modern.summary.weekly` | Weekly cross-channel performance summary |
| `modern.summary.anomalies` | Flagged anomalies in recent data |

If any of these don't exist yet on the live MCP, the corresponding skill either:
- Falls back to asking the user (functional but degraded), or
- Is held back from v1 until the tool ships

The MVP release (v0.1.0) should ship only skills whose tools are 100% available.

---

## Skill modification template

Every existing or new skill follows this structure. Below is the template used for the `paid-ltv-optimization` skill as an example.

```markdown
---
name: paid-ltv-optimization
description: Use when the user wants to optimize paid acquisition based on
  LTV economics rather than CAC alone. Triggers: "my paid channels aren't
  profitable", "how do I scale Meta without blowing CAC", "what's my
  payback period", "should I pause this channel", "compare LTV across
  acquisition sources". For tactical ad creative or copy, see ads. For
  pre-acquisition CRO, see cro.
metadata:
  version: 1.0.0
  data_dependencies: [modern.ads.cac_by_channel, modern.retention.cohort_ltv]
---

# Paid LTV Optimization

You are an ecomm growth strategist. Your goal is to evaluate paid acquisition
channels through an LTV lens — not just CAC, not just first-purchase ROAS,
but the full payback economics by channel and cohort.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:
- Current monthly ad spend
- Active channels (Google, Meta, TikTok, etc.)
- Average order value and product margins
- Subscription vs one-time mix

## Procedure

1. **Pull last-90-day blended CAC by channel.**
   If `modern-mcp` is connected:
   ```
   modern.ads.cac_by_channel(
     start_date="<90 days ago>",
     end_date="<today>",
     channels=["google", "meta", "tiktok"]
   )
   ```
   Otherwise ask the user for spend and new-customer counts by channel.

2. **Pull cohort LTV at 90 and 180 days.**
   If `modern-mcp` is connected:
   ```
   modern.retention.cohort_ltv(
     cohort_start="<6 months ago>",
     cohort_end="<3 months ago>",
     window_days=[90, 180]
   )
   ```
   Otherwise ask for repeat purchase rate and AOV.

3. **Compute per-channel:**
   - LTV:CAC ratio at 90 and 180 days
   - Payback period
   - Margin-adjusted LTV (if margin data available)

4. **Apply the LTV optimization framework:**
   - Channels with LTV:CAC > 3 at 90 days → scale
   - Channels with LTV:CAC < 1 at 180 days → pause or restructure
   - Channels in the middle → investigate creative / audience refinement

5. **Output recommendations in three sections:**
   - Scale (with target spend increase)
   - Hold and optimize (with specific tests)
   - Pause or restructure (with reasons)

## Related Skills

- `cohort-retention` — deeper analysis of retention curves
- `ads` — tactical channel-specific guidance
- `subscription-growth` — for subscription-heavy economics

## Output Format

Structured markdown with the three recommendation sections, a per-channel
table showing CAC / 90-day LTV / 180-day LTV / payback / verdict, and one
paragraph naming the highest-leverage test to run next.
```

Every skill in the pack follows this shape: frontmatter with `data_dependencies`, an Initial Assessment section that reads the context file, a Procedure section that names MCP tools by identifier, a framework section, and a related-skills section.

---

## Tenant context file: `.agents/modern-ai-context.md`

Generated by Modern AI's onboarding flow. Updated when the user's connected sources change. Contents:

```markdown
# Modern AI Context — <org-name>

Last updated: <ISO timestamp>
Modern AI org: <slug>

## Brand
Voice: <2-3 sentences>
Tone do: <list>
Tone don't: <list>

## ICP
Primary: <description>
Secondary: <description>
Pain points: <list>
Buying triggers: <list>

## Product catalog
Top SKUs by revenue (last 90d):
- <SKU 1> — <category> — <margin band>
- <SKU 2> — ...

## Channels
Active paid: <list with spend bands>
Active organic: <list>
Top email flows: <list>

## KPIs
Monthly revenue band: <range>
Target ROAS by channel: <breakdown>
Target CAC: <number>
LTV target (180d): <number>
```

The skills read this file at the start of every invocation. The user never sees it directly; it's machinery.

**Generation:** Modern AI's onboarding flow writes it to the user's working directory at:
- Mac/Linux: `.agents/modern-ai-context.md (relative to your project root or working directory)`
- Windows: `%USERPROFILE%\.agents\modern-ai-context.md`

Skills look for it via the standard Agent Skills convention.

---

## Implementation checklist

In order, what eng needs to do to ship v0.1.0:

1. **Confirm MCP tool surface.** Run `tools/list` against `https://mcp.modern.ai/mcp`. Reconcile this doc's surface against actual. Fix names, identify gaps.

2. **Generate `.agents/modern-ai-context.md` from onboarding.** This file is the linchpin for the personalization story. Without it the skills work but feel generic.

3. **Write 8 v1 skills** following the template above:
   - `subscription-growth`, `repeat-purchase`, `paid-ltv-optimization`,
     `cart-abandonment-recovery`, `subscription-churn`, `bundle-pricing`,
     `cohort-retention`, `winback-flows`
   - Each ≤500 lines. Each has 5–8 eval cases in `evals/evals.json`.

4. **Write the validator** (`scripts/validate-skills.sh`) that enforces:
   - Required frontmatter (name, description, metadata.version, metadata.data_dependencies)
   - Trigger phrases in description (at least 3)
   - Scope cross-references in description (at least 1 "see X" or "for X, see Y")
   - SKILL.md ≤500 lines
   - All tools named in `data_dependencies` actually exist in the MCP tool surface

5. **Write the eval runner** (`scripts/run-evals.js`) that:
   - Spawns the agent with the plugin loaded
   - Sends each eval prompt
   - Scores output against the assertion list
   - Reports pass/fail/skip per case

6. **CI:** validator + evals run on every PR. Both must pass.

7. **Marketplace publication.** Standard Agent Skills format goes to whichever marketplace Modern AI distributes through.

---

## What "directly integrated" means in practice

A user installs the plugin, connects the MCP, asks: "How is my repeat purchase rate trending?"

Without this integration spec, the agent answers as if it were a tutor: "Repeat purchase rate is typically..."

With this integration spec, the `repeat-purchase` skill's procedure says "if modern-mcp is connected, call `modern.retention.repeat_rate(window_days=30, start_date=<-90d>, end_date=<today>)`." The agent does it. Gets the user's actual number. Applies the retention framework to that number. Outputs recommendations grounded in real data.

That's the difference between a marketing tutor and a marketing operator. The skill content does the operator work; the MCP supplies the operator's data.

---

## Open items for you to confirm before eng starts

1. **MCP tool surface** — the table in this doc is inferred. Run a `tools/list` against `https://mcp.modern.ai/mcp` and reconcile.
2. **Tenant context file format** — the template above is a starting point. If Modern AI's onboarding already generates context in a different shape, conform to that instead.
3. **Naming** — plugin name (`modern-ai/modern-skills`?), marketplace listing path, version (`v0.1.0`?).
4. **Scope for v0.1.0** — which 8 skills out of the proposed 10 ship in v1. I'd default to the 8 listed in implementation checklist step 3, but swap based on which MCP tools are confirmed live today.
5. **Pricing/access enforcement** — does the plugin check the user's plan tier (Pro/Enterprise) before connecting? Or is that enforced server-side by the MCP rejecting calls from non-Pro keys? Latter is cleaner.
