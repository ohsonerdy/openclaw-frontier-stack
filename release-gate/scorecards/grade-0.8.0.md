# OpenClaw Frontier Stack scorecard — v0.8.0

- Generated: 2026-05-20T01:27:17.142Z
- Schema: openclaw-frontier.grade.v1
- Composite: **99** (A)

## Executive summary

Composite 99 (A) across 6 present categories. No category fell below 60.

## Category breakdown

| Category | Weight | Score | Detail |
|---|---:|---:|---|
| skill-eval-live | 25 | n/a | tier-3 not run; pass --tier-3 to enable |
| skill-triggering-accuracy | 10 | n/a | tier-3 not run; pass --tier-3 to enable |
| coordination-correctness | 15 | 100 | 5/5 probes passing |
| goal-loop-reliability | 15 | 100 | 10/10 success, p50 27ms / p95 28ms |
| release-gate-strictness | 15 | n/a | mutation-testing skipped via --skip-mutation |
| surface-integrity | 10 | 95 | 1 finding(s), commits checked 10 |
| reference-runtime-parity | 5 | 100 | 6/6 HIGH rows closed |
| docs-freshness | 5 | 100 | 44 doc(s), 0 stale, 23 fresh |
| public-safety | gate | 100 | 0 finding(s), gate=false |

## Escaped mutations (release-gate-strictness)

- (mutation testing skipped)

## Recommendations

- surface-integrity: score 95/100, weight 10 (weighted gap 0.5)
- coordination-correctness: score 100/100, weight 15 (weighted gap 0.0)
- goal-loop-reliability: score 100/100, weight 15 (weighted gap 0.0)
