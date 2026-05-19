# OpenClaw Frontier Stack scorecard — v0.8.0

- Generated: 2026-05-19T19:49:04.345Z
- Schema: openclaw-frontier.grade.v1
- Composite: **100** (A)

## Executive summary

Composite 100 (A) across 7 present categories. No category fell below 60.

## Category breakdown

| Category | Weight | Score | Detail |
|---|---:|---:|---|
| skill-eval-live | 25 | n/a | tier-3 not run; pass --tier-3 to enable |
| skill-triggering-accuracy | 10 | n/a | tier-3 not run; pass --tier-3 to enable |
| coordination-correctness | 15 | 100 | 5/5 probes passing |
| goal-loop-reliability | 15 | 100 | 10/10 success, p50 14ms / p95 17ms |
| release-gate-strictness | 15 | 100 | caught 17/17, escaped 0, rollbackClean=true |
| surface-integrity | 10 | 100 | 0 finding(s), commits checked 13 |
| hermes-parity | 5 | 100 | 6/6 HIGH rows closed |
| docs-freshness | 5 | 100 | 44 doc(s), 0 stale, 18 fresh |
| public-safety | gate | 100 | 0 finding(s), gate=false |

## Escaped mutations (release-gate-strictness)

- (none — every mutation was caught by the verifier)

## Recommendations

- coordination-correctness: score 100/100, weight 15 (weighted gap 0.0)
- goal-loop-reliability: score 100/100, weight 15 (weighted gap 0.0)
- release-gate-strictness: score 100/100, weight 15 (weighted gap 0.0)
