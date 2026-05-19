# OpenClaw Frontier Stack scorecard — v0.7.0

- Generated: 2026-05-19T19:09:33.143Z
- Schema: openclaw-frontier.grade.v1
- Composite: **50** (F) — capped by public-safety gate

## Executive summary

Composite 50 (F) across 6 present categories. Composite capped at 50 because the public-safety gate fired. 1 category is below the 60 threshold: public-safety. Public-safety scanner reported at least one finding; treat the candidate as not shippable until cleared.

## Category breakdown

| Category | Weight | Score | Detail |
|---|---:|---:|---|
| skill-eval-live | 25 | n/a | tier-3 not run; pass --tier-3 to enable |
| skill-triggering-accuracy | 10 | n/a | tier-3 not run; pass --tier-3 to enable |
| coordination-correctness | 15 | 100 | 5/5 probes passing |
| goal-loop-reliability | 15 | 100 | 10/10 success, p50 13ms / p95 17ms |
| release-gate-strictness | 15 | n/a | mutation-testing skipped via --skip-mutation |
| surface-integrity | 10 | 100 | 0 finding(s), commits checked 13 |
| hermes-parity | 5 | 100 | 6/6 HIGH rows closed |
| docs-freshness | 5 | 100 | 44 doc(s), 0 stale, 18 fresh |
| public-safety | gate | 0 | 1 finding(s), gate=true |

## Escaped mutations (release-gate-strictness)

- (mutation testing skipped)

## Recommendations

- coordination-correctness: score 100/100, weight 15 (weighted gap 0.0)
- goal-loop-reliability: score 100/100, weight 15 (weighted gap 0.0)
- surface-integrity: score 100/100, weight 10 (weighted gap 0.0)
