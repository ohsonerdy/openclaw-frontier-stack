# Skill Eval Telemetry

Operator guide for the nightly Modern Skills eval workflow: what it does, how to read it, and how to react when it goes red.

## Why run nightly evals at all

Skills are prompts plus structure. They drift in three quiet ways, all of which a nightly run catches before a user does:

1. **Model drift.** The same skill text against `claude-sonnet-4-6` today and `claude-sonnet-4-6` six weeks from now is not the same eval. Anthropic ships incremental updates. A skill that confidently named the five subscription-specific CRO levers in February can start hedging in May. Nightly runs catch the slope before it becomes a cliff.
2. **Skill regression.** Someone edits `SKILL.md` to fix a niche case and accidentally removes the line that anchored the entire framework. The skill still loads, still passes structural validation, still feels right in a one-shot review — and silently fails 4 of 7 evals. The nightly run is the canary.
3. **Model upgrades.** Before flipping the default model to a new release (e.g. `claude-opus-4-7`), you want a side-by-side: same evals, two models, one report. The workflow's `workflow_dispatch` input lets you do that on demand without changing anything in the repo.

The bar is intentionally low — substring-match heuristics, ~7 evals per skill — because the goal is *cheap continuous signal*, not high-fidelity grading. Cheap signal that runs every day beats expensive signal that runs quarterly.

## How to configure

### Auth — OAuth preferred, API key opt-in

The eval runner supports two auth modes for live runs against the default Anthropic backend:

| Auth | Env var (local) | Repo secret (CI) | Billing |
|---|---|---|---|
| **OAuth (preferred)** | `ANTHROPIC_OAUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` | `ANTHROPIC_OAUTH_TOKEN` | Charged to the token holder's Claude Pro/Max subscription |
| **API key (opt-in fallback)** | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Charged per-token via Anthropic API billing |

The runner picks OAuth automatically when an OAuth token is present; it only falls back to the API key when no OAuth token is set. If both are configured, OAuth wins.

**Recommended for CI:** set `ANTHROPIC_OAUTH_TOKEN` as the repo secret so nightly evals draw from your subscription, not from per-token API billing. Set `ANTHROPIC_API_KEY` only if you have a reason to want API-billed runs (separate cost center, separate org, etc.).

**Where to get an OAuth token for CI:**

- Run `claude /login` locally (Claude Code) and export the resulting OAuth token from your local config
- Or use the Anthropic Console's OAuth flow to generate a long-lived token bound to your subscription account
- Store the token as a repo secret under **Settings → Secrets and variables → Actions → New repository secret**

If you don't yet have a working OAuth token in CI, set `ANTHROPIC_API_KEY` instead — the workflow will use it without code changes. Migrate to OAuth when ready.

If neither is set, the eval runner exits with code 2 before making any HTTP calls and prints the auth-resolution priority. Dry-run mode (`npm run eval:dry`) does NOT require auth at all and is always free.

## Multi-model backends

The runner supports three backends: the default Anthropic API, any OpenAI-compatible server (vLLM, llama.cpp's `server`, OpenRouter, Together, etc.), and Ollama. The choice is made by two flags (or their env-var equivalents):

| Flag | Env var | Default | Notes |
|---|---|---|---|
| `--endpoint <url>` | `OPENCLAW_EVAL_ENDPOINT` | `https://api.anthropic.com` | Base URL, no trailing slash needed. |
| `--api-format <fmt>` | `OPENCLAW_EVAL_API_FORMAT` | `anthropic` for `api.anthropic.com`, `openai` for everything else | `anthropic` posts `/v1/messages` with the Messages-API shape; `openai` posts `/v1/chat/completions` with the standard `messages: [{role,content}]` shape. |

Auth resolution differs by format:

- **Anthropic format** — unchanged from above: `ANTHROPIC_OAUTH_TOKEN` > `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`.
- **OpenAI format** — `OPENCLAW_EVAL_API_KEY` > `OPENAI_API_KEY`, sent as `Authorization: Bearer <key>`. If neither is set AND the endpoint host is `localhost` or `127.0.0.1`, the runner sends no `Authorization` header (Ollama default). Remote endpoints without a key are rejected with exit code 2.

The report's `auth` field is now an object so traceability is preserved across backends:

```json
"auth": { "kind": "oauth", "endpoint": "https://api.anthropic.com", "apiFormat": "anthropic" }
```

`kind` is one of `oauth`, `api-key`, `bearer`, or `none`.

### Ollama

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1/...` once `ollama serve` is running.

```bash
# 1. Make sure Ollama is up and the model is pulled
ollama pull llama3
ollama serve   # default port 11434

# 2. Run the evals
node scripts/run-skill-evals.js --live \
  --model llama3 \
  --endpoint http://localhost:11434 \
  --api-format openai
```

No `OPENCLAW_EVAL_API_KEY` is required because the endpoint is local. You can still set one — Ollama tolerates arbitrary `Authorization` headers — which is useful if you put Ollama behind a reverse proxy that does enforce a token.

If Ollama is not running, the runner returns clean `endpoint unreachable (ECONNREFUSED): http://localhost:11434` errors per eval rather than crashing.

### vLLM

vLLM ships an OpenAI-compatible server. The default is `http://localhost:8000`, but most production deployments live on an internal hostname and require Bearer auth.

```bash
# Local, no auth
node scripts/run-skill-evals.js --live \
  --model meta-llama/Meta-Llama-3-8B-Instruct \
  --endpoint http://localhost:8000 \
  --api-format openai

# Remote, with auth
export OPENCLAW_EVAL_API_KEY="vllm-shared-secret"
node scripts/run-skill-evals.js --live \
  --model mistralai/Mistral-7B-Instruct-v0.3 \
  --endpoint https://vllm.internal.example.com \
  --api-format openai
```

The runner sends the standard `messages: [{role:'system',...},{role:'user',...}]` payload to `/v1/chat/completions` and reads `parsed.choices[0].message.content`. Token usage is captured if vLLM returns the optional `usage` block (it usually does).

### CI wiring

The workflow exposes three new env vars sourced from repo secrets/vars:

- `OPENCLAW_EVAL_ENDPOINT` (repo variable) — base URL of the alternate backend
- `OPENCLAW_EVAL_API_FORMAT` (repo variable) — usually `openai`
- `OPENCLAW_EVAL_API_KEY` (repo secret) — Bearer token if required

Leave all three unset to keep the default Anthropic backend.

### Optional: success-comment target

If you want the workflow to drop a one-line "evals green" comment on a tracking issue when the run passes, set a repo variable (not a secret):

- **Settings → Secrets and variables → Actions → Variables → New repository variable**
- Name: `EVAL_TRACKING_ISSUE`
- Value: the issue number, e.g. `42`

Leave it unset to skip the success comment entirely. The failure path always opens or updates an issue regardless of this variable.

### Schedule

The cron is `0 9 * * *` — 09:00 UTC daily. That lands at 05:00 ET / 04:00 CT, which means a failure-issue notification is sitting in your inbox by the time the US East work day starts. GitHub-scheduled workflows can be delayed by up to ~15 minutes during peak load; if you need a tighter SLA, run hourly or run on a dedicated runner.

## How to read the eval report JSON

The eval runner writes a single JSON document to stdout, which the workflow redirects to `release-gate/reports/eval-report-<date>-<model>.json` and uploads as a workflow artifact named `eval-report-<date>-<model>`. The schema is `modern-skills.eval-report.v1`:

```json
{
  "schema": "modern-skills.eval-report.v1",
  "generatedAt": "2026-05-17T09:00:01.234Z",
  "mode": "live",
  "model": "claude-sonnet-4-6",
  "auth": {
    "kind": "oauth",
    "endpoint": "https://api.anthropic.com",
    "apiFormat": "anthropic"
  },
  "skillsScanned": 8,
  "ok": false,
  "skills": [
    {
      "name": "subscription-growth",
      "ok": false,
      "evalCount": 7,
      "assertionCount": 41,
      "passed": 5,
      "failed": 2,
      "evals": [
        {
          "id": 1,
          "ok": true,
          "passedAssertions": 8,
          "totalAssertions": 8,
          "output": "...truncated to 2000 chars...",
          "usage": { "input_tokens": 4123, "output_tokens": 812 },
          "assertions": [
            {
              "assertion": "Checks for .agents/modern-ai-context.md",
              "pass": true,
              "tokens": ["checks", "agents", "modern-ai-context.md"],
              "hits": ["checks", "agents", "modern-ai-context.md"]
            }
          ]
        }
      ]
    }
  ]
}
```

Key fields:

- `ok` (top level) — `true` only if every assertion in every eval passed and no eval file was malformed.
- `skills[].ok` — per-skill rollup.
- `skills[].evals[].ok` — true if `passedAssertions === totalAssertions` for that eval.
- `skills[].evals[].assertions[].tokens` / `.hits` — the heuristic's working data. If `hits / tokens >= 0.5` the assertion passes. This is intentionally lenient.
- `skills[].evals[].usage` — token usage as returned by the Anthropic API (`input_tokens`, `output_tokens`, plus cache fields if present). Aggregate this to track cost trends.
- `skills[].error` — present when `evals.json` was missing or unreadable.
- `skills[].structuralErrors` — present when `evals.json` parsed but failed schema validation. Should be impossible in scheduled runs because the workflow runs `npm run eval:dry` first and bails on structural errors.

The workflow also writes a Markdown summary table to the job summary view so you can scan pass/fail counts without downloading the artifact.

## The assertion-scoring heuristic

The heuristic in `scripts/run-skill-evals.js` is intentionally simple and substring-shaped:

1. From the human-readable assertion string (e.g. `"Calls modern.subscriptions.churn_rate split by voluntary and involuntary"`), extract distinctive tokens via regex: dotted identifiers (`modern.subscriptions.churn_rate`), capitalised multi-word phrases, and any lowercase word four characters or longer.
2. Lowercase both the token list and the model output.
3. Count how many tokens appear as substrings in the output.
4. An assertion passes if at least **50%** of distinctive tokens are present.

That's it. There is no semantic comparison, no LLM-as-judge step, no embedding similarity. The reasoning is:

- A skill that genuinely covers the right ground will mention the right nouns, in any phrasing.
- 50% is the lowest threshold that still distinguishes "the model engaged with this framework" from "the model riffed in adjacent territory".
- Substring is robust to paraphrasing in a way that exact-match isn't. "Recommends reactivation flow as a candidate first move" passes whether the model says "you should turn on a reactivation flow" or "the reactivation series is the highest-leverage place to start".

The weakness is real: a model can score the right tokens by accident, and a model can miss tokens while saying the right thing in unfamiliar words. Treat the score as a smoke signal, not a grade. When an eval flips from pass to fail (or back), read the full output text in the report artifact before concluding anything.

## Triggering an ad-hoc run

Two routes:

### Via the GitHub UI

**Actions → Scheduled Modern Skills evals → Run workflow**. Choose:

- **model** — one of `claude-sonnet-4-6` (default), `claude-opus-4-7`, `claude-haiku-4-5-20251001`.
- **skill** — optional, leave blank to run all skills, or type a single skill directory name (e.g. `cohort-retention`).

The run uses the same secret and the same artifact path scheme as scheduled runs, so an ad-hoc run can be compared cleanly against a nightly baseline.

### Via the gh CLI

```bash
gh workflow run scheduled-evals.yml \
  --field model=claude-opus-4-7 \
  --field skill=subscription-growth
```

The CLI accepts the same inputs and queues the run on the default branch.

## Testing a model upgrade

When Anthropic ships a new model id, you want to evaluate it against your skills *before* changing any defaults. Workflow:

1. From a local clone with current `main`, run the dry-run to confirm nothing is structurally broken: `npm run eval:dry`.
2. Trigger the workflow with `model=<new-model-id>` if the id is already in the choice list, or run it locally:
   ```bash
   export ANTHROPIC_API_KEY=...
   npm run eval:live -- --model <new-model-id> > /tmp/eval-new-model.json
   ```
   The choice list in `scheduled-evals.yml` can be expanded later if the new id should be a permanent option.
3. Diff the new model's report against the most recent nightly artifact for the current default. Pay attention to:
   - Skills that pass on the old model and fail on the new one (or vice versa).
   - Token-usage shifts (especially output tokens — new models can be more verbose or terse).
   - Per-assertion `hits` arrays: a regression in a single skill often shows up as a few specific tokens disappearing.
4. If the new model is materially better, update the workflow default and the eval scripts' documented examples in `README.md` to reference the new id. If it is materially worse on multiple skills, stay on the current default and open an issue tracking the gap.

## Cost expectations

Rough sizing for a nightly run with the current 8 skills × ~7 evals = ~56 calls:

- **System prompt (the SKILL.md)**: ~2–4k tokens per skill. The runner re-sends the system prompt on every call for that skill (no client-side prompt-caching), so each of the ~7 calls for a given skill is ~2–4k input tokens.
- **User prompt (the eval prompt)**: ~50–200 tokens.
- **Output**: skills are tuned to produce structured Quick Wins / High-Impact / Test Ideas sections, typical output is ~800–1500 tokens.

Per-call rough budget: ~3.5k input + ~1.2k output.
Full-run rough budget: 56 × 3.5k ≈ **~196k input tokens**, 56 × 1.2k ≈ **~67k output tokens**.

At Sonnet-class pricing (~$3/M input, ~$15/M output as of early 2026), a nightly run is roughly:

- Input: 196k × $3/M ≈ **$0.59**
- Output: 67k × $15/M ≈ **$1.00**
- **Total per nightly run: ~$1.50–2.00**

At ~30 nightly runs per month plus a handful of ad-hoc dispatches, the monthly bill is in the **$50–80** range. Opus-class runs cost roughly 5× that; Haiku-class runs cost roughly one-fifth. If you stand up prompt caching on the system prompt (one cache breakpoint per skill, since the SKILL.md is static within a run), the per-call input drops to ~10% of full price after the first call per skill, cutting total cost by ~40–50%.

These numbers are rough; the exact bill depends on the model id and any Anthropic pricing changes. Pull the actual `usage` aggregates from a few recent reports to refine.

## What to do when an eval fails

The workflow opens or updates an issue labelled `eval-regression` containing the failing eval ids, the model, the date, and a link to the report artifact. From there, the triage tree:

### Step 1: download the artifact and read the failing eval's `output` text

The `output` field on each eval is the model's actual response (truncated to 2000 chars). Read it. Three questions, in order:

#### (a) Is the assertion wrong?

This is the most common cause of "false" failures. The heuristic looks for distinctive tokens; the model can say the right thing using different words. Examples of mismatches we have hit:

- Assertion: `"Recommends a month-2 or month-3 switch-to-annual offer placement"`. Model output: `"the best place to introduce annual is 60 to 90 days into the subscription"`. Tokens `month-2`, `month-3` are not in the output → fail, even though the substance is right.
- Assertion: `"Names the 17% conventional discount band"`. Model output: `"discount in the 15-20% range"`. Token `17%` is missing → fail.

If you read the output and it's genuinely on-target, **update the assertion** in `skills/<skill>/evals/evals.json` to use more permissive token shapes (e.g. `"Recommends switch-to-annual offer in month-2 or month-3 or 60-90 day window"`). Run `npm run eval:dry` to validate, then re-trigger the workflow.

#### (b) Is the skill text causing the wrong behaviour?

If the model output is wrong on substance — it skips the framework, jumps to the wrong recommendation, or invents a model — the skill itself regressed. Check git log on `skills/<skill>/SKILL.md` for recent edits. The fix is usually one of:

- A removed line that anchored the framework — restore it.
- A new line that confused the precedence (e.g. "always recommend pause first") — soften or scope it.
- An overgrown skill — split it into a parent skill and a child reference.

#### (c) Is it a model-side issue?

If the assertions are reasonable, the skill is unchanged in git, and the model output is materially worse than two weeks ago, the model itself shifted. Check:

- The same eval against the previous model id (use ad-hoc dispatch with the old model).
- The Anthropic changelog and any recent model-card updates.
- Other skills failing the same way (model-side issues tend to manifest across multiple skills, not one).

If it's confirmed model-side, the response options are:

1. **Wait one cycle** if the regression is minor and the model is in active iteration.
2. **Open an upstream report** to Anthropic with the failing eval prompts and outputs.
3. **Roll back the default model** if the regression is material (`workflow_dispatch` default in `scheduled-evals.yml`, and the README examples).
4. **Tighten the skill** to compensate — usually a band-aid; document it as such in the skill's changelog.

## Decision tree

```
Eval failed
├── Read the model's output text in the report artifact
│
├── Output says the right thing in different words?
│   → Update the assertion to be more permissive
│   → Run npm run eval:dry to validate
│   → Close the regression issue with a note
│
├── Output is wrong on substance?
│   ├── Was SKILL.md edited recently?
│   │   → Skill regression
│   │   → Revert or rework the recent edit
│   │   → Re-run the workflow
│   │
│   └── SKILL.md unchanged, output materially worse than baseline?
│       → Model-side issue
│       ├── Compare against previous model via ad-hoc dispatch
│       ├── Check Anthropic changelog
│       ├── If material: roll back the default model
│       └── If minor: wait one cycle, document the gap
│
└── Eval file structurally invalid?
    → Should be impossible (eval:dry runs first)
    → Fix evals.json shape and re-run dry-run locally
```

## Optional: extending with custom evaluators

The current heuristic is substring-match; it cannot catch:

- Hallucinated function calls (`modern.subscriptions.churn` vs the real `modern.subscriptions.churn_rate`).
- Numeric reasoning errors (CAC payback math off by a factor of 2).
- Markdown structure (does the output actually have a Quick Wins section header, or did the model just mention the words "quick wins" in prose?).

To extend, two patterns work well:

### Hog-style deterministic evaluators

For things you can encode as a function: write a JS file under `scripts/eval-checks/` exporting `{ name, applies(evalCase), check(output, evalCase) }`. Wire it into `run-skill-evals.js` alongside the substring heuristic. Example use cases:

- Section-header validator: parse the output as Markdown, require `## Quick Wins`, `## High-Impact`, `## Test Ideas` headers.
- Function-call shape validator: scan for `modern.<area>.<method>` patterns and check them against a generated whitelist.
- Numeric sanity validator: regex-extract dollar amounts and validate ranges.

These run alongside the substring heuristic; the eval passes only if all configured checks pass.

### LLM-judge evaluators

For things that genuinely require a language model to grade: add a second pass that sends the original eval prompt, the model output, and the assertion to a judge model (typically Sonnet or Opus) with a structured-output prompt asking "does the output satisfy this assertion: yes/no, with reasoning". Cost roughly doubles. Use sparingly — only on the assertions that the substring heuristic chronically gets wrong.

A judge prompt template lives well under `scripts/eval-judges/` and the runner can be extended to take `--judge` as a flag.

## Operational checklist

When standing this up for the first time:

- [ ] Set `ANTHROPIC_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY` as a repo secret for the default Anthropic backend.
- [ ] (Optional) Set `OPENCLAW_EVAL_ENDPOINT` / `OPENCLAW_EVAL_API_FORMAT` (repo variables) and `OPENCLAW_EVAL_API_KEY` (repo secret) if running against Ollama, vLLM, or any other OpenAI-compatible backend.
- [ ] (Optional) Set `EVAL_TRACKING_ISSUE` as a repo variable for green-day notes.
- [ ] Run `gh workflow run scheduled-evals.yml` once manually to confirm it works end-to-end.
- [ ] Read the resulting report artifact and confirm the per-skill pass counts look sane against your expectations.
- [ ] Subscribe to the `eval-regression` label (or pin a saved search) so failure issues reach the right person.
- [ ] Schedule a monthly review of the assertion text — keep the heuristic in sync with how the model phrases things.

## Related

- Eval runner source: `scripts/run-skill-evals.js`
- Eval files: `skills/<skill>/evals/evals.json`
- Workflow: `.github/workflows/scheduled-evals.yml`
- Skill validation: `scripts/validate-skills.sh` and `npm run verify:skills`
- Skills integration spec: `docs/skills-integration-spec.md`
