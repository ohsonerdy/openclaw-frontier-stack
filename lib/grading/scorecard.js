'use strict';

/**
 * lib/grading/scorecard.js — render a Grade object as operator-safe markdown.
 *
 * Layout:
 *   1. Header: schema/version/date, letter + composite.
 *   2. Executive summary (2-3 sentences synthesised from the per-category
 *      scores).
 *   3. Category table (id | weight | score | summary detail).
 *   4. Escaped-mutation list (release-gate-strictness category only). Empty
 *      bullet if no mutations escaped.
 *   5. Recommendations (top 3 lowest-scoring categories ranked by their
 *      weighted contribution gap).
 *
 * No emojis. No PII. Operator-safe.
 */

const { WEIGHTS } = require('./composite.js');

function fmtScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'n/a';
  return String(score);
}

function categoryRowDetail(category) {
  const d = category.detail || {};
  if (category.id === 'release-gate-strictness') {
    if (d.reason) return d.reason;
    return `caught ${d.caught || 0}/${d.totalMutations || 0}, escaped ${(d.escaped || []).length}, rollbackClean=${d.rollbackClean !== false}`;
  }
  if (category.id === 'surface-integrity') {
    return `${d.findingCount || 0} finding(s), commits checked ${d.checkedCommits || 0}`;
  }
  if (category.id === 'public-safety') {
    return `${d.findingCount || 0} finding(s), gate=${Boolean(d.gate)}`;
  }
  if (category.id === 'reference-runtime-parity') {
    return `${d.closed || 0}/${d.highRowsTotal || 0} HIGH rows closed`;
  }
  if (category.id === 'docs-freshness') {
    return `${d.docsScanned || 0} doc(s), ${d.staleCount || 0} stale, ${d.freshCount || 0} fresh`;
  }
  if (category.id === 'coordination-correctness') {
    return `${d.passing || 0}/${d.total || 0} probes passing`;
  }
  if (category.id === 'goal-loop-reliability') {
    const lat = d.latency || {};
    return `${d.successes || 0}/${d.iterations || 0} success, p50 ${lat.p50ms || 0}ms / p95 ${lat.p95ms || 0}ms`;
  }
  if (category.id === 'skill-eval-live') {
    if (d.reason) return d.reason;
    return `skill-eval-live: ${d.summary || 'no detail'}`;
  }
  if (category.id === 'skill-triggering-accuracy') {
    if (d.reason) return d.reason;
    return `skill-triggering-accuracy: ${d.summary || 'no detail'}`;
  }
  return JSON.stringify(d).slice(0, 100);
}

function executiveSummary(grade) {
  const present = grade.categories.filter((c) => typeof c.score === 'number');
  const failing = present.filter((c) => c.score < 60);
  const safety = grade.categories.find((c) => c.id === 'public-safety');
  const capped = grade.composite && grade.composite.capped;
  const letter = grade.composite ? grade.composite.letter : 'F';
  const score = grade.composite ? grade.composite.score : 0;
  const parts = [];
  parts.push(`Composite ${score} (${letter}) across ${present.length} present categor${present.length === 1 ? 'y' : 'ies'}.`);
  if (capped) parts.push('Composite capped at 50 because the public-safety gate fired.');
  if (failing.length === 0) parts.push('No category fell below 60.');
  else parts.push(`${failing.length} categor${failing.length === 1 ? 'y is' : 'ies are'} below the 60 threshold: ${failing.map((f) => f.id).join(', ')}.`);
  if (safety && safety.score === 0) parts.push('Public-safety scanner reported at least one finding; treat the candidate as not shippable until cleared.');
  return parts.join(' ');
}

function recommendations(grade) {
  const present = grade.categories.filter((c) => typeof c.score === 'number' && c.id !== 'public-safety');
  const gaps = present.map((c) => {
    const weight = WEIGHTS[c.id] || 0;
    const gap = (100 - c.score) * (weight / 100);
    return { id: c.id, score: c.score, weight, weightedGap: gap };
  }).sort((a, b) => b.weightedGap - a.weightedGap);
  const top = gaps.slice(0, 3);
  if (top.length === 0) return '- No recommendations: every present category scored 100.';
  return top.map((r) => `- ${r.id}: score ${r.score}/100, weight ${r.weight} (weighted gap ${r.weightedGap.toFixed(1)})`).join('\n');
}

function escapedMutationList(grade) {
  const cat = grade.categories.find((c) => c.id === 'release-gate-strictness');
  if (!cat || !cat.detail || cat.detail.reason) return '- (mutation testing skipped)';
  const escaped = cat.detail.escaped || [];
  if (escaped.length === 0) return '- (none — every mutation was caught by the verifier)';
  return escaped.map((id) => `- ${id}`).join('\n');
}

function categoryTable(grade) {
  const lines = [];
  lines.push('| Category | Weight | Score | Detail |');
  lines.push('|---|---:|---:|---|');
  for (const c of grade.categories) {
    const weight = WEIGHTS[c.id];
    const weightCell = weight ? String(weight) : 'gate';
    lines.push(`| ${c.id} | ${weightCell} | ${fmtScore(c.score)} | ${categoryRowDetail(c)} |`);
  }
  return lines.join('\n');
}

function renderScorecard(grade) {
  if (!grade || typeof grade !== 'object') throw new Error('renderScorecard: grade is required');
  const composite = grade.composite || { score: 0, letter: 'F' };
  const lines = [];
  lines.push(`# OpenClaw Frontier Stack scorecard — v${grade.version || '0.0.0'}`);
  lines.push('');
  lines.push(`- Generated: ${grade.generatedAt || new Date().toISOString()}`);
  lines.push(`- Schema: ${grade.schema || 'openclaw-frontier.grade.v1'}`);
  lines.push(`- Composite: **${composite.score}** (${composite.letter})${composite.capped ? ' — capped by public-safety gate' : ''}`);
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(executiveSummary(grade));
  lines.push('');
  lines.push('## Category breakdown');
  lines.push('');
  lines.push(categoryTable(grade));
  lines.push('');
  lines.push('## Escaped mutations (release-gate-strictness)');
  lines.push('');
  lines.push(escapedMutationList(grade));
  lines.push('');
  lines.push('## Recommendations');
  lines.push('');
  lines.push(recommendations(grade));
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  renderScorecard,
  executiveSummary,
  recommendations,
  categoryTable,
};
