'use strict';

/**
 * lib/grading/composite.js — weighted-average composite scoring.
 *
 * Weights (sum = 100 if all categories present):
 *   skill-eval-live           25
 *   skill-triggering-accuracy 10
 *   coordination-correctness  15
 *   goal-loop-reliability     15
 *   release-gate-strictness   15
 *   surface-integrity         10
 *   reference-runtime-parity              5
 *   docs-freshness             5
 *
 * Composite = weighted average over PRESENT categories only. Weights of
 * skipped categories (score === null) are reweighted across the remaining.
 *
 * Special case — public-safety gate: this category is NOT in the composite
 * weighting, but if its score is 0 the composite is capped at 50.
 *
 * Letter grade:
 *   A >= 90, B >= 80, C >= 70, D >= 60, F < 60.
 */

const WEIGHTS = Object.freeze({
  'skill-eval-live': 25,
  'skill-triggering-accuracy': 10,
  'coordination-correctness': 15,
  'goal-loop-reliability': 15,
  'release-gate-strictness': 15,
  'surface-integrity': 10,
  'reference-runtime-parity': 5,
  'docs-freshness': 5,
});

function letterFor(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'F';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * @param {Array<{id, score: number|null}>} categoryRows
 * @param {{ publicSafetyScore: number|null }} gateState
 * @returns {{ score: number, letter: string, weightsUsed: object, capped: boolean }}
 */
function composeScore(categoryRows, gateState = {}) {
  let numerator = 0;
  let denominator = 0;
  const weightsUsed = {};
  for (const row of categoryRows) {
    const weight = WEIGHTS[row.id];
    if (!weight) continue;
    if (typeof row.score !== 'number' || row.score === null || Number.isNaN(row.score)) continue;
    numerator += row.score * weight;
    denominator += weight;
    weightsUsed[row.id] = weight;
  }
  const raw = denominator === 0 ? 0 : numerator / denominator;
  let final = Math.round(raw);
  let capped = false;
  if (typeof gateState.publicSafetyScore === 'number' && gateState.publicSafetyScore === 0 && final > 50) {
    final = 50;
    capped = true;
  }
  return {
    score: final,
    letter: letterFor(final),
    weightsUsed,
    capped,
  };
}

module.exports = {
  WEIGHTS,
  letterFor,
  composeScore,
};
