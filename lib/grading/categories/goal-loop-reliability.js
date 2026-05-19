'use strict';

/**
 * goal-loop-reliability — run N mock-mode goal loops, measure success rate
 * and percentile latencies.
 *
 * Score = success_rate * 100 (rounded). Latency is reported in detail but
 * does not factor into the score (latency is host-dependent).
 *
 * Mock mode means no live model and no real ledger persistence outside the
 * tmp dir used per run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runGoalLoop } = require('../../../src/orchestrator/lib/goal-loop.js');

function buildGoal(i) {
  return {
    schema: 'openclaw-frontier.goal.v1',
    id: `GOAL-GRADE-LOOP-${String(i).padStart(3, '0')}`,
    status: 'active',
    owner: 'orchestrator',
    source: 'lib/grading/categories/goal-loop-reliability.js',
    title: 'grade-loop-reliability probe',
    definitionOfDone: 'All lanes report a result on the ledger.',
    cadence: { operatorUpdateMinutes: 30, channel: 'operator-chat' },
    lanes: [
      { name: 'implementation', role: 'builder', summary: 'mock build' },
      { name: 'verification', role: 'verifier', summary: 'mock verify' },
      { name: 'release-packaging', role: 'release_manager', summary: 'mock package' },
    ],
    green: [],
    red: [],
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

async function score(opts = {}) {
  const n = typeof opts.iterations === 'number' && opts.iterations > 0 ? opts.iterations : 10;
  const samples = [];
  let successes = 0;
  for (let i = 0; i < n; i += 1) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ofs-grade-gl-${i}-`));
    const blackboardPath = path.join(tmp, 'blackboard.jsonl');
    const goalsDir = path.join(tmp, 'goals');
    const started = Date.now();
    let ok = false;
    let error = null;
    try {
      const trace = await runGoalLoop({
        goal: buildGoal(i),
        blackboardPath,
        maxWaitMs: 5000,
        pollIntervalMs: 25,
        mockAgents: true,
        persistState: true,
        goalsDir,
      });
      ok = Boolean(trace && trace.ok);
    } catch (err) {
      error = String(err.message || err);
    }
    const elapsed = Date.now() - started;
    samples.push({ iteration: i, ok, elapsedMs: elapsed, error });
    if (ok) successes += 1;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const sorted = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const successRate = samples.length === 0 ? 0 : successes / samples.length;
  return {
    score: Math.round(successRate * 100),
    detail: {
      iterations: samples.length,
      successes,
      failures: samples.length - successes,
      successRate,
      latency: {
        p50ms: p50,
        p95ms: p95,
        minMs: sorted[0] || 0,
        maxMs: sorted[sorted.length - 1] || 0,
      },
      sampleErrors: samples.filter((s) => s.error).slice(0, 3).map((s) => ({ iteration: s.iteration, error: s.error })),
    },
  };
}

module.exports = { score };
