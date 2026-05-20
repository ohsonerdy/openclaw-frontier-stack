'use strict';

/**
 * lib/grading/grade.js — composite grade entry point.
 *
 * Coordinates: runs every category's score(opts) function, optionally folds
 * tier-3 results provided by the caller (or loaded from cache), assembles
 * the composite using lib/grading/composite.js, and returns the canonical
 * Grade record.
 *
 * Return shape:
 *   {
 *     schema: 'openclaw-frontier.grade.v1',
 *     version: '<pkg version>',
 *     generatedAt: '<iso>',
 *     composite: { score, letter, capped, weightsUsed },
 *     categories: [
 *       { id, name, weight, score, detail },
 *       ...
 *     ],
 *     tier3: { loaded, source, ... }
 *   }
 *
 * Options:
 *   - root             absolute repo root (defaults to lib/grading/.. four ups)
 *   - version          override; defaults to package.json#version
 *   - skipMutation     true to skip release-gate-strictness
 *   - mutations        optional subset of mutation ids (filter)
 *   - tier3            true to enable tier-3 categories (live skill eval).
 *                      If liveEvalResult is provided, it's used. Otherwise
 *                      we try to load release-gate/reports/grade-skill-eval-live-cache.json.
 *                      If neither is available, tier-3 categories are skipped
 *                      (score: null, detail.reason).
 *   - liveEvalResult   pre-computed object: { score, detail, triggering: { score, detail } }
 *   - onProgress       callback({ stage, id, ... })
 *
 * Hard constraint: this function MUST NOT mutate the working tree. The
 * mutation-runner is the only place that touches files outside the report
 * dir, and it reverts everything before returning.
 */

const fs = require('fs');
const path = require('path');

const composite = require('./composite.js');
const releaseGate = require('./categories/release-gate-strictness.js');
const surfaceIntegrity = require('./categories/surface-integrity.js');
const publicSafety = require('./categories/public-safety.js');
const referenceRuntimeParity = require('./categories/reference-runtime-parity.js');
const docsFreshness = require('./categories/docs-freshness.js');
const coordination = require('./categories/coordination-correctness.js');
const goalLoopReliability = require('./categories/goal-loop-reliability.js');
const skillEvalLive = require('./categories/skill-eval-live.js');
const skillTriggeringAccuracy = require('./categories/skill-triggering-accuracy.js');

const CATEGORY_DEFS = [
  { id: 'skill-eval-live', name: 'Skill eval (live model)', tier: 3 },
  { id: 'skill-triggering-accuracy', name: 'Skill triggering accuracy (live model)', tier: 3 },
  { id: 'coordination-correctness', name: 'Coordination correctness (mock)', tier: 2 },
  { id: 'goal-loop-reliability', name: 'Goal-loop reliability (mock)', tier: 2 },
  { id: 'release-gate-strictness', name: 'Release-gate strictness (mutation testing)', tier: 4 },
  { id: 'surface-integrity', name: 'Public-surface integrity (static)', tier: 1 },
  { id: 'reference-runtime-parity', name: 'Reference runtime parity (static)', tier: 1 },
  { id: 'docs-freshness', name: 'Docs freshness (static)', tier: 1 },
  { id: 'public-safety', name: 'Public-safety gate (static)', tier: 1 },
];

function readPackageVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    try { onProgress(payload); } catch (_) { /* best-effort */ }
  }
}

async function scoreTier3(opts, root) {
  const tier3Enabled = Boolean(opts.tier3);
  let liveScore = { score: null, detail: { reason: 'tier-3 not run; pass --tier-3 to enable' } };
  let triggerScore = { score: null, detail: { reason: 'tier-3 not run; pass --tier-3 to enable' } };
  let source = 'not-loaded';
  if (!tier3Enabled) return { liveScore, triggerScore, source };

  // Caller may inject a pre-computed tier-3 result (used by tests and by
  // out-of-band grading runs).
  const provided = opts.liveEvalResult && typeof opts.liveEvalResult === 'object' ? opts.liveEvalResult : null;
  if (provided) {
    source = 'caller-provided';
    if (typeof provided.score === 'number') liveScore = { score: provided.score, detail: provided.detail || {} };
    else if (provided.skillEvalLive) liveScore = provided.skillEvalLive;
    if (provided.triggering) triggerScore = provided.triggering;
    return { liveScore, triggerScore, source };
  }

  // No caller-provided result — call the live categories directly. Each
  // category gracefully returns { score: null, detail: 'no-anthropic-credential' }
  // when no OAuth/API key is set, so the composite stays well-defined.
  try {
    liveScore = await skillEvalLive.score({});
    triggerScore = await skillTriggeringAccuracy.score({});
    source = 'live-category-invocation';
  } catch (err) {
    source = 'tier-3-live-invocation-failed';
    const errMsg = String(err && err.message ? err.message : err);
    liveScore = { score: null, detail: { reason: `tier-3 live category threw: ${errMsg}` } };
    triggerScore = { score: null, detail: { reason: `tier-3 live category threw: ${errMsg}` } };
  }
  return { liveScore, triggerScore, source };
}

async function runGrade(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..');
  const version = opts.version || readPackageVersion(root);
  const generatedAt = new Date().toISOString();
  const onProgress = opts.onProgress || null;

  emitProgress(onProgress, { stage: 'start', version });

  // Run static + mock categories.
  emitProgress(onProgress, { stage: 'category-start', id: 'public-safety' });
  const publicSafetyResult = await publicSafety.score({ root });
  emitProgress(onProgress, { stage: 'category-done', id: 'public-safety', score: publicSafetyResult.score });

  emitProgress(onProgress, { stage: 'category-start', id: 'surface-integrity' });
  const surfaceIntegrityResult = await surfaceIntegrity.score({ root });
  emitProgress(onProgress, { stage: 'category-done', id: 'surface-integrity', score: surfaceIntegrityResult.score });

  emitProgress(onProgress, { stage: 'category-start', id: 'reference-runtime-parity' });
  const referenceRuntimeParityResult = await referenceRuntimeParity.score({ root });
  emitProgress(onProgress, { stage: 'category-done', id: 'reference-runtime-parity', score: referenceRuntimeParityResult.score });

  emitProgress(onProgress, { stage: 'category-start', id: 'docs-freshness' });
  const docsFreshnessResult = await docsFreshness.score({ root });
  emitProgress(onProgress, { stage: 'category-done', id: 'docs-freshness', score: docsFreshnessResult.score });

  emitProgress(onProgress, { stage: 'category-start', id: 'coordination-correctness' });
  const coordResult = await coordination.score({ root });
  emitProgress(onProgress, { stage: 'category-done', id: 'coordination-correctness', score: coordResult.score });

  emitProgress(onProgress, { stage: 'category-start', id: 'goal-loop-reliability' });
  const goalLoopResult = await goalLoopReliability.score({ root, iterations: opts.goalLoopIterations || 10 });
  emitProgress(onProgress, { stage: 'category-done', id: 'goal-loop-reliability', score: goalLoopResult.score });

  // Mutation testing — only if not skipped.
  emitProgress(onProgress, { stage: 'category-start', id: 'release-gate-strictness' });
  const releaseGateResult = await releaseGate.score({
    root,
    skip: Boolean(opts.skipMutation),
    mutations: Array.isArray(opts.mutations) ? opts.mutations : null,
    perMutationTimeoutMs: opts.perMutationTimeoutMs || 60000,
    onProgress: onProgress ? (p) => emitProgress(onProgress, { stage: 'mutation-progress', ...p }) : null,
  });
  emitProgress(onProgress, { stage: 'category-done', id: 'release-gate-strictness', score: releaseGateResult.score });

  // Tier-3 live eval — optional.
  emitProgress(onProgress, { stage: 'tier3-start' });
  const tier3 = await scoreTier3(opts, root);
  emitProgress(onProgress, { stage: 'tier3-done', source: tier3.source });

  const categories = [
    { id: 'skill-eval-live', name: 'Skill eval (live model)', weight: composite.WEIGHTS['skill-eval-live'], ...tier3.liveScore },
    { id: 'skill-triggering-accuracy', name: 'Skill triggering accuracy (live model)', weight: composite.WEIGHTS['skill-triggering-accuracy'], ...tier3.triggerScore },
    { id: 'coordination-correctness', name: 'Coordination correctness (mock)', weight: composite.WEIGHTS['coordination-correctness'], ...coordResult },
    { id: 'goal-loop-reliability', name: 'Goal-loop reliability (mock)', weight: composite.WEIGHTS['goal-loop-reliability'], ...goalLoopResult },
    { id: 'release-gate-strictness', name: 'Release-gate strictness (mutation testing)', weight: composite.WEIGHTS['release-gate-strictness'], ...releaseGateResult },
    { id: 'surface-integrity', name: 'Public-surface integrity (static)', weight: composite.WEIGHTS['surface-integrity'], ...surfaceIntegrityResult },
    { id: 'reference-runtime-parity', name: 'Reference runtime parity (static)', weight: composite.WEIGHTS['reference-runtime-parity'], ...referenceRuntimeParityResult },
    { id: 'docs-freshness', name: 'Docs freshness (static)', weight: composite.WEIGHTS['docs-freshness'], ...docsFreshnessResult },
    { id: 'public-safety', name: 'Public-safety gate (static)', weight: null, ...publicSafetyResult },
  ];

  const compositeRecord = composite.composeScore(
    categories.map((c) => ({ id: c.id, score: c.score })),
    { publicSafetyScore: publicSafetyResult.score },
  );

  emitProgress(onProgress, { stage: 'done', composite: compositeRecord });

  return {
    schema: 'openclaw-frontier.grade.v1',
    version,
    generatedAt,
    composite: compositeRecord,
    categories,
    tier3: {
      enabled: Boolean(opts.tier3),
      source: tier3.source,
    },
  };
}

module.exports = {
  runGrade,
  CATEGORY_DEFS,
};
