#!/usr/bin/env node
'use strict';

/**
 * lib/grading/test/grade-system.test.js — node-native tests for the grading
 * system. Covers:
 *
 *   1. Each category's score() returns the expected shape (score, detail).
 *   2. composite.composeScore math + skipped reweighting + public-safety cap.
 *   3. scorecard.renderScorecard markdown shape over a synthetic grade.
 *   4. mutation-runner reverts on a synthetic mutation against a tmp scratch
 *      file (not the real repo). Both the apply + revert paths exercised.
 *   5. Mutation-list integrity: every mutation has the required keys, and
 *      no two mutations share an id.
 *   6. Public-safety gate caps composite at 50 when its score is 0.
 *
 * No live network. No model calls. No repo mutations.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const composite = require('../composite.js');
const { renderScorecard } = require('../scorecard.js');
const { MUTATIONS } = require('../mutations.js');
const { runMutationSweep } = require('../mutation-runner.js');
const surfaceIntegrity = require('../categories/surface-integrity.js');
const publicSafety = require('../categories/public-safety.js');
const referenceRuntimeParity = require('../categories/reference-runtime-parity.js');
const docsFreshness = require('../categories/docs-freshness.js');
const coordination = require('../categories/coordination-correctness.js');
const goalLoop = require('../categories/goal-loop-reliability.js');
const releaseGate = require('../categories/release-gate-strictness.js');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function shapeCheck(label, result) {
  assert.ok(result && typeof result === 'object', `${label}: must return an object`);
  assert.ok('score' in result, `${label}: missing score field`);
  assert.ok(result.score === null || typeof result.score === 'number', `${label}: score must be number or null`);
  if (typeof result.score === 'number') {
    assert.ok(result.score >= 0 && result.score <= 100, `${label}: score out of range`);
  }
  assert.ok(result.detail && typeof result.detail === 'object', `${label}: missing detail object`);
}

async function testCompositeMath() {
  const rows = [
    { id: 'coordination-correctness', score: 100 },
    { id: 'goal-loop-reliability', score: 100 },
    { id: 'release-gate-strictness', score: 80 },
    { id: 'surface-integrity', score: 90 },
    { id: 'reference-runtime-parity', score: 100 },
    { id: 'docs-freshness', score: 100 },
  ];
  const out = composite.composeScore(rows, { publicSafetyScore: 100 });
  // Weighted average: (100*15 + 100*15 + 80*15 + 90*10 + 100*5 + 100*5) / (15+15+15+10+5+5)
  // = (1500 + 1500 + 1200 + 900 + 500 + 500) / 65 = 6100 / 65 = 93.85 -> 94
  assert.strictEqual(out.score, 94, `composite math wrong: got ${out.score}`);
  assert.strictEqual(out.letter, 'A', `composite letter wrong`);
  assert.strictEqual(out.capped, false);

  // Skipped reweighting: drop release-gate-strictness; rest should reweight.
  const rows2 = [
    { id: 'coordination-correctness', score: 100 },
    { id: 'surface-integrity', score: 80 },
  ];
  const out2 = composite.composeScore(rows2, { publicSafetyScore: 100 });
  // (100*15 + 80*10) / (15+10) = (1500+800)/25 = 2300/25 = 92
  assert.strictEqual(out2.score, 92);
  assert.strictEqual(out2.letter, 'A');
}

async function testCompositeCap() {
  const rows = [
    { id: 'coordination-correctness', score: 100 },
    { id: 'goal-loop-reliability', score: 100 },
    { id: 'release-gate-strictness', score: 100 },
    { id: 'surface-integrity', score: 100 },
    { id: 'reference-runtime-parity', score: 100 },
    { id: 'docs-freshness', score: 100 },
  ];
  const out = composite.composeScore(rows, { publicSafetyScore: 0 });
  assert.strictEqual(out.score, 50, `cap should pin to 50, got ${out.score}`);
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.letter, 'F');
}

async function testLetterBands() {
  assert.strictEqual(composite.letterFor(95), 'A');
  assert.strictEqual(composite.letterFor(90), 'A');
  assert.strictEqual(composite.letterFor(89), 'B');
  assert.strictEqual(composite.letterFor(80), 'B');
  assert.strictEqual(composite.letterFor(79), 'C');
  assert.strictEqual(composite.letterFor(70), 'C');
  assert.strictEqual(composite.letterFor(60), 'D');
  assert.strictEqual(composite.letterFor(59), 'F');
  assert.strictEqual(composite.letterFor(0), 'F');
  assert.strictEqual(composite.letterFor(null), 'F');
}

async function testScorecardRenders() {
  const grade = {
    schema: 'openclaw-frontier.grade.v1',
    version: '9.9.9',
    generatedAt: '2026-01-01T00:00:00Z',
    composite: { score: 84, letter: 'B', capped: false, weightsUsed: {} },
    categories: [
      { id: 'release-gate-strictness', name: 'rg', score: 80, detail: { totalMutations: 5, caught: 4, escaped: ['m-1'], rollbackClean: true } },
      { id: 'surface-integrity', name: 'si', score: 95, detail: { findingCount: 1, checkedCommits: 100 } },
      { id: 'public-safety', name: 'ps', score: 100, detail: { findingCount: 0, gate: false } },
      { id: 'reference-runtime-parity', name: 'hp', score: 90, detail: { closed: 5, highRowsTotal: 6 } },
      { id: 'docs-freshness', name: 'df', score: 100, detail: { docsScanned: 38, staleCount: 0, freshCount: 38 } },
      { id: 'coordination-correctness', name: 'cc', score: 100, detail: { passing: 5, total: 5 } },
      { id: 'goal-loop-reliability', name: 'gl', score: 100, detail: { successes: 10, iterations: 10, latency: { p50ms: 50, p95ms: 80 } } },
      { id: 'skill-eval-live', name: 'sel', score: null, detail: { reason: 'tier-3 not run' } },
      { id: 'skill-triggering-accuracy', name: 'sta', score: null, detail: { reason: 'tier-3 not run' } },
    ],
    tier3: { enabled: false, source: 'not-loaded' },
  };
  const md = renderScorecard(grade);
  assert.ok(md.includes('Composite: **84** (B)'), 'scorecard composite header missing');
  assert.ok(md.includes('| release-gate-strictness |'), 'scorecard category table missing');
  assert.ok(md.includes('m-1'), 'scorecard escaped-mutation list missing');
  assert.ok(md.includes('## Recommendations'), 'recommendations section missing');
  assert.ok(!/[^\x00-\x7F]/.test(md.replace(/—/g, '-')), 'scorecard should be ASCII-safe (em-dash only allowed)');
}

async function testMutationListIntegrity() {
  const ids = new Set();
  for (const m of MUTATIONS) {
    assert.ok(m.id && typeof m.id === 'string', `mutation missing id: ${JSON.stringify(m)}`);
    assert.ok(typeof m.description === 'string' && m.description.length > 0, `mutation ${m.id} missing description`);
    assert.ok(typeof m.apply === 'function', `mutation ${m.id} missing apply`);
    assert.ok(typeof m.revert === 'function', `mutation ${m.id} missing revert`);
    assert.ok(!ids.has(m.id), `duplicate mutation id: ${m.id}`);
    ids.add(m.id);
  }
  assert.ok(MUTATIONS.length >= 15, `expected at least 15 mutations, got ${MUTATIONS.length}`);
}

async function testMutationRunnerOnSyntheticTree() {
  // Build a tmp scratch dir that looks like a tiny repo. Inject a synthetic
  // mutation that toggles a file. Confirm: apply changes the bytes, the
  // verifier (here a fake bash that checks for the file's pristine bytes)
  // catches the mutation, revert restores, and the sweep reports caught=1.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-grade-mutation-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sentinel.txt'), 'PRISTINE\n');
    // Synthetic verifier: exits 0 if sentinel.txt == PRISTINE, 1 otherwise.
    const verifierSource = [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      "const root = process.cwd();",
      "const text = fs.readFileSync(path.join(root, 'sentinel.txt'), 'utf8').trim();",
      "if (text === 'PRISTINE') process.exit(0); else process.exit(1);",
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'scripts', 'verify-package.js'), verifierSource);

    const syntheticMutation = {
      id: 'synthetic-flip-sentinel',
      description: 'flip sentinel.txt to MUTATED so the verifier exits non-zero',
      _saved: null,
      apply(root) {
        this._saved = fs.readFileSync(path.join(root, 'sentinel.txt'), 'utf8');
        fs.writeFileSync(path.join(root, 'sentinel.txt'), 'MUTATED\n');
      },
      revert(root) {
        if (this._saved != null) fs.writeFileSync(path.join(root, 'sentinel.txt'), this._saved);
      },
    };

    const sweep = await runMutationSweep({
      root: tmp,
      mutations: [syntheticMutation],
      perMutationTimeoutMs: 10000,
    });

    assert.strictEqual(sweep.mutations.length, 1, 'one mutation processed');
    assert.strictEqual(sweep.mutations[0].caught, true, 'verifier should catch the synthetic mutation');
    assert.strictEqual(sweep.escaped.length, 0, 'nothing should escape');
    assert.strictEqual(sweep.rollbackClean, true, 'rollback must restore the tree');
    const restored = fs.readFileSync(path.join(tmp, 'sentinel.txt'), 'utf8');
    assert.strictEqual(restored, 'PRISTINE\n', 'sentinel.txt must be restored');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testStaticCategoriesAgainstRepo() {
  // Touch every static / mock category against the real repo and confirm
  // they return the expected shape. We don't assert specific scores — those
  // depend on the working tree — only that they execute and return valid
  // shapes.
  const r1 = await publicSafety.score({ root: repoRoot });
  shapeCheck('public-safety', r1);
  const r2 = await surfaceIntegrity.score({ root: repoRoot });
  shapeCheck('surface-integrity', r2);
  const r3 = await referenceRuntimeParity.score({ root: repoRoot });
  shapeCheck('reference-runtime-parity', r3);
  const r4 = await docsFreshness.score({ root: repoRoot });
  shapeCheck('docs-freshness', r4);
}

async function testCoordinationAndGoalLoopMockProbes() {
  const r1 = await coordination.score({ root: repoRoot });
  shapeCheck('coordination-correctness', r1);
  assert.ok(r1.detail.total >= 5, 'expected at least 5 coordination probes');
  const r2 = await goalLoop.score({ root: repoRoot, iterations: 3 });
  shapeCheck('goal-loop-reliability', r2);
  assert.strictEqual(r2.detail.iterations, 3, 'goal-loop iteration count honored');
}

async function testReleaseGateSkipPath() {
  const r = await releaseGate.score({ root: repoRoot, skip: true });
  assert.strictEqual(r.score, null, 'skip path must return score null');
  assert.ok(r.detail.reason, 'skip path must include reason');
  assert.ok(r.detail.totalMutations >= 15, 'skip path still reports total mutation count');
}

async function main() {
  const tests = [
    ['compositeMath', testCompositeMath],
    ['compositeCap', testCompositeCap],
    ['letterBands', testLetterBands],
    ['scorecardRenders', testScorecardRenders],
    ['mutationListIntegrity', testMutationListIntegrity],
    ['mutationRunnerOnSyntheticTree', testMutationRunnerOnSyntheticTree],
    ['staticCategoriesAgainstRepo', testStaticCategoriesAgainstRepo],
    ['coordinationAndGoalLoopMockProbes', testCoordinationAndGoalLoopMockProbes],
    ['releaseGateSkipPath', testReleaseGateSkipPath],
  ];
  const failed = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      process.stdout.write(`ok ${name}\n`);
    } catch (err) {
      failed.push({ name, err });
      process.stdout.write(`not ok ${name}: ${err.message}\n`);
    }
  }
  if (failed.length > 0) {
    for (const f of failed) process.stderr.write(`${f.name}: ${f.err.stack || f.err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, name: 'grade-system.test', tests: tests.length }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`grade-system.test failed: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
