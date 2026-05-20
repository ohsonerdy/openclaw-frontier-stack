# OpenClaw Frontier Stack — grading system

The grade system gives a quantitative, reproducible composite score for any
tagged version of the stack. Anyone can run `npm run grade` against a fresh
checkout and obtain the same number for tier-1/2/4 categories. Tier-3
requires an Anthropic OAuth token.

The grade exists because skeptics deserve a brutally honest answer. It
deliberately includes mutation testing, not just static checks, so that the
release gate cannot drift into "always green" while the codebase weakens.

## How to run

```
npm run grade                  # full grade (tier 1, 2, 4; tier 3 if available)
npm run grade:dry              # skip tier-4 (mutation testing) for fast iteration
node scripts/grade.js --tier-3 # enable tier-3 live skill eval
node scripts/grade.js --skip-mutation --json
node scripts/grade.js --mutations delete-incident-response-skill,fake-package-version
```

Outputs (under repo root):

```
release-gate/reports/grade-<version>.json
release-gate/scorecards/grade-<version>.md
```

Exit code: 0 if composite is at least 60 AND the public-safety gate did not
fire. Non-zero otherwise.

## The eight categories

| ID | Tier | Weight | What it measures |
|---|---:|---:|---|
| skill-eval-live | 3 | 25 | End-to-end live-model skill execution: a skill is invoked against a live API and the response is scored against the eval rubric. |
| skill-triggering-accuracy | 3 | 10 | Whether the right skill is triggered by ambiguous prompts. |
| coordination-correctness | 2 | 15 | The five coordination patterns (fan-out, fan-in, chain, voting, subagent) drive mock-mode ledger scenarios; expected results must match. |
| goal-loop-reliability | 2 | 15 | Ten mock-mode goal loops run sequentially; success rate becomes the score. p50/p95 latencies appear in detail (not scored). |
| release-gate-strictness | 4 | 15 | Mutation testing. The runner introduces a defined set of breakages and verifies the package verifier catches each one. |
| surface-integrity | 1 | 10 | Re-runs the public-surface harness. Score = 100 - findings * 5, floored at 0. |
| reference-runtime-parity | 1 | 5 | Counts HIGH-priority gap-table rows in docs/reference-runtime-audit.md that the current code base has closed. |
| docs-freshness | 1 | 5 | For each docs/*.md, compares the doc's last-commit time to the most recent change in the inferred source dir; doc older than 180 days while source moved is stale. |
| public-safety | gate | gate | Binary. Zero findings from the private-content scanner => 100. Any finding => 0. If 0, the composite is capped at 50 regardless of any other category. |

## Composite formula

```
composite = weighted-average over present categories
  where each category's weight is reweighted across present categories
  (skipped categories are removed from both numerator and denominator)
if public-safety score == 0:
  composite = min(composite, 50)
```

Letter grade: A >= 90, B >= 80, C >= 70, D >= 60, F < 60.

The composite reflects only categories with a numeric score. If tier-3 is
skipped, the remaining 65 points of weight (tier-1/2/4 plus public-safety
gate) carry the full composite. This makes `npm run grade:dry` directly
comparable to a full run with respect to the categories it does run.

## How to read a scorecard

Each scorecard has five sections:

1. **Header** — version, generated timestamp, composite + letter, and a
   note if the public-safety gate capped the composite.
2. **Executive summary** — two to three sentences synthesised from the
   per-category outcomes.
3. **Category breakdown** — a table with each category's id, weight,
   score, and a short detail string.
4. **Escaped mutations** — bullet list of mutation ids that the verifier
   failed to catch (mutation testing only). If mutation testing was
   skipped, the bullet says so.
5. **Recommendations** — the top three categories ranked by weighted-gap
   from 100, surfacing the highest-leverage places to invest next.

The scorecard is operator-safe. No emojis, no PII, no internal paths.

## How to add a new mutation

Mutations live in `lib/grading/mutations.js`. Each one is an object with:

```
{
  id: 'kebab-case-unique-id',
  description: 'short prose; no emojis, operator-safe',
  apply(root) { /* perform the mutation in the working tree */ },
  revert(root) { /* restore the previous state; idempotent */ },
}
```

Use the helpers `saveFile(id, root, rel)` and `restoreFile(id, root, rel)`
to make revert atomic — the helpers snapshot the original bytes (or the
file's absence) under the mutation's id, and the revert routine restores
exactly what was there before.

Tests:

1. Add the mutation to the `MUTATIONS` array.
2. Run `node lib/grading/test/grade-system.test.js` — the integrity test
   confirms every mutation has the required shape and ids are unique.
3. Run `node scripts/grade.js --mutations <your-id>` to confirm your
   mutation is caught by the verifier. If it is not caught, EITHER the
   verifier has a gap (file an issue) OR the mutation is too subtle and
   should target a different surface.

Hard rules:

- The revert MUST be idempotent. Calling it twice must not produce a
  different result than calling it once.
- Mutations MUST NOT use `git stash` — the runner does not require a
  clean working tree (Adam may be mid-wave) and stash would lose those
  uncommitted edits.
- Mutations MUST NOT touch git history. Only working-tree files.
- After the full sweep, the runner re-hashes the working tree and
  panic-aborts if anything drifted.

## How to add a new category

1. Add a module under `lib/grading/categories/<id>.js` that exports
   `score(opts)` returning `{ score: number|null, detail: object }`.
2. Add the category id + weight to the `WEIGHTS` map in
   `lib/grading/composite.js`. Weights across all categories should
   total 100 (when the public-safety gate is excluded — the gate is
   not in the weighted sum).
3. Add a row to the table in this document.
4. Wire the category into `runGrade()` in `lib/grading/grade.js`. Use
   the existing categories as a template.
5. Add a probe to `lib/grading/test/grade-system.test.js` that asserts
   the new category returns the expected shape.

## Reproducibility

For tier-1/2/4 categories, anyone running `npm run grade` against the
same git commit will get the same composite score modulo:

- Goal-loop p50/p95 latencies (host-dependent, reported in detail but
  not scored).
- Mutation duration values (host-dependent, reported in detail).
- Tier-3 categories — those depend on the live model's responses.

For tier-3 reproducibility, the workflow under `.github/workflows/grade.yml`
runs against the same Anthropic OAuth token and pins the model lineup in
`lib/cost-table.json`. The skill-eval-live cache file at
`release-gate/reports/grade-skill-eval-live-cache.json` is consulted when
`--tier-3` is set; provide a fresh cache to reproduce a prior tier-3 run
exactly.

## Time budget

The full grade sweep should complete in under 10 minutes on a recent
build host. The mutation runner caps each individual mutation at 60
seconds; if a mutation makes the verifier hang past that, the runner
kills the child and records the mutation as caught (it broke the
verifier so badly it could not complete).

`npm run grade:dry` (skip tier-4) typically completes in under one
minute.
