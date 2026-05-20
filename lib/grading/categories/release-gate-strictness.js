'use strict';

/**
 * release-gate-strictness — mutation testing.
 *
 * Score = (caught / total) * 100. The detail records the full list of
 * mutations, which ones escaped, the rollback status, and the wall-clock
 * duration. If the rollback failed the score is forced to 0 regardless of
 * how many mutations were caught — a broken revert is a release-stopping
 * event.
 *
 * Options:
 *   - root             absolute path to repo
 *   - mutations        optional subset of mutation ids
 *   - perMutationTimeoutMs
 *   - skip             when true, return score: null, detail.reason
 */

const path = require('path');
const { runMutationSweep } = require('../mutation-runner.js');
const { MUTATIONS } = require('../mutations.js');

async function score(opts = {}) {
  if (opts.skip) {
    return {
      score: null,
      detail: {
        reason: 'mutation-testing skipped via --skip-mutation',
        totalMutations: MUTATIONS.length,
      },
    };
  }
  const root = opts.root || path.resolve(__dirname, '..', '..', '..');
  let selected = null;
  if (Array.isArray(opts.mutations) && opts.mutations.length > 0) {
    const idSet = new Set(opts.mutations);
    selected = MUTATIONS.filter((m) => idSet.has(m.id));
    if (selected.length === 0) {
      return {
        score: null,
        detail: { reason: 'mutation-testing: no matching ids', requested: opts.mutations },
      };
    }
  }
  const sweep = await runMutationSweep({
    root,
    mutations: selected,
    perMutationTimeoutMs: opts.perMutationTimeoutMs || 60000,
    onProgress: opts.onProgress || null,
  });
  const total = sweep.mutations.length;
  const caught = sweep.mutations.filter((m) => m.caught).length;
  const raw = total === 0 ? 0 : Math.round((caught / total) * 100);
  const finalScore = sweep.rollbackClean ? raw : 0;
  return {
    score: finalScore,
    detail: {
      totalMutations: total,
      caught,
      escaped: sweep.escaped,
      rollbackClean: sweep.rollbackClean,
      rollbackDiff: sweep.rollbackDiff || null,
      durationMs: sweep.durationMs,
      mutations: sweep.mutations.map((m) => ({
        id: m.id,
        caught: m.caught,
        durationMs: m.durationMs,
        exitCode: m.exitCode,
        timedOut: Boolean(m.timedOut),
        error: m.error || null,
      })),
    },
  };
}

module.exports = { score };
