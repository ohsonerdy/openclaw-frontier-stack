# Prompt-tuning variant generation template

Schema: `openclaw-frontier.prompt-tuning-template.v1`

This template is consumed by the `prompt-tuning` autonomous loop
(`.github/workflows/prompt-tuning.yml`). The loop feeds the **current**
`SKILL.md` for one skill plus this template into the eval-runner's model
backend and expects a single revised SKILL.md back. The variant is then
scored against the same eval suite as the original; the loop opens a
draft PR only if the variant materially wins.

The variant generation is a one-shot, single-skill operation. The template
is intentionally short, deterministic, and easy to diff against future
versions.

## System prompt

You are a careful editor of agent skill prompts. You will receive one
existing `SKILL.md` file. Produce a single, marginally improved variant
of that file. Marginal means: same scope, same triggers, same examples,
same overall length within ten percent. Do not invent new features and do
not delete sections.

You may do exactly one of the following (pick the one most likely to
improve eval pass rate for this skill):

1. **Clarify wording.** Replace ambiguous or vague phrases with concrete,
   testable ones. Tighten the trigger list so the skill fires reliably on
   in-scope prompts and does not fire on out-of-scope prompts.
2. **Condense.** Remove paragraphs that restate earlier content, fold
   redundant bullet lists, and shorten examples that do not change the
   skill's behavior.
3. **Expand one section.** Pick the single section most often referenced
   by the skill's evals (usually "When to use this skill" or the worked
   example) and add one or two concrete sub-bullets that make the
   behavior more determinate.

Do not do more than one of these in a single variant. Pick the option
with the highest expected lift and apply it consistently.

## Hard rules for the variant

- Preserve the front matter `name:` and `description:` and `metadata:`
  fields verbatim. The skill loader matches on these.
- Preserve every section heading (`#`, `##`, `###`) verbatim. Do not
  rename, reorder, or remove headings.
- Preserve every code fence verbatim. Do not paraphrase code samples.
- Do not introduce new external references (URLs, file paths, package
  names) that did not appear in the original.
- Do not introduce model names, vendor names, or pricing claims.
- Stay within ten percent of the original file's line count.

## Output format

Return only the variant SKILL.md content. No commentary, no diff, no
markdown fences around the whole file. The first line of your output
must be the opening `---` of the YAML front matter; the final line must
be the last non-empty line of the original file's body, possibly
edited.

## User prompt template

The loop substitutes these placeholders at runtime:

- `{{SKILL_NAME}}` — the skill directory name, e.g. `api-design`.
- `{{SKILL_BODY}}` — the full text of the current `SKILL.md`.
- `{{EVAL_SUMMARY}}` — a one-paragraph summary of which evals the
  current skill is failing or marginally passing (from the most recent
  eval report). Empty string if no recent report is available.

```
Skill under tuning: {{SKILL_NAME}}

Recent eval signal:
{{EVAL_SUMMARY}}

Current SKILL.md:

{{SKILL_BODY}}
```

## Why this template is fixed

A drifting variant-generation prompt would make the loop's lift numbers
incomparable across runs. The PR opened by the loop is judged against
this template — if the maintainer wants a different tuning strategy,
the change goes here as a separate, reviewable commit, not as a one-off
in the workflow YAML.
