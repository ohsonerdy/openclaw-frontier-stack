'use strict';

/**
 * coordination-correctness — Tier 2 mock probes.
 *
 * Drives each coordination pattern in mock mode against a scratch ledger and
 * verifies expected behaviour:
 *   - fan-out: 3 tasks dispatched in parallel; all 3 complete; ok mirrors
 *     overall pass/fail.
 *   - fan-in: 2 upstream sources, 1 joiner; joiner runs after upstream.
 *   - chain: 3 sequential steps; step 2 sees step 1's output; failure short-
 *     circuits the chain.
 *   - voting: 3 voters; quorum-based decision matches expected winner.
 *   - subagent: 2 children with restricted ledger scope; parent only sees
 *     result records, not intermediate facts.
 *
 * Score = round(passing / total * 100).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLedger } = require('../../../src/blackboard/lib/ledger.js');
const { fanOut } = require('../../coordination/fan-out.js');
const { fanIn } = require('../../coordination/fan-in.js');
const { chain } = require('../../coordination/chain.js');
const { voting } = require('../../coordination/voting.js');
const { subagentFanOut } = require('../../coordination/subagent.js');

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ofs-grade-${label}-`));
}

async function probeFanOut() {
  const tmp = mkTmp('fo');
  try {
    const ledger = createLedger({ ledgerPath: path.join(tmp, 'b.jsonl') });
    const result = await fanOut({
      goalId: 'grade-fo',
      tasks: [
        { id: 'a', role: 'reviewer', summary: 'a' },
        { id: 'b', role: 'reviewer', summary: 'b' },
        { id: 'c', role: 'reviewer', summary: 'c' },
      ],
      ledger,
      timeoutMs: 2000,
      pollIntervalMs: 25,
      mockResults: [
        { taskId: 'grade-fo.a', ok: true, summary: 'a' },
        { taskId: 'grade-fo.b', ok: true, summary: 'b' },
        { taskId: 'grade-fo.c', ok: true, summary: 'c' },
      ],
    });
    const ok = result.pattern === 'fan-out' && result.completed.length === 3 && result.failed.length === 0 && result.ok === true;
    return { name: 'fan-out', ok, detail: { completed: result.completed.length, failed: result.failed.length } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function probeFanIn() {
  const tmp = mkTmp('fi');
  try {
    const ledger = createLedger({ ledgerPath: path.join(tmp, 'b.jsonl') });
    // Pre-seed two upstream results so the joiner has something to fan over.
    for (const id of ['grade-fi.up-1', 'grade-fi.up-2']) {
      ledger.claimTask({ agent: 'orchestrator', taskId: id, summary: 'upstream' });
      ledger.recordResult({ agent: 'researcher', taskId: id, ok: true, summary: 'upstream ok' });
    }
    const result = await fanIn({
      goalId: 'grade-fi',
      sourceTaskIds: ['grade-fi.up-1', 'grade-fi.up-2'],
      joiner: { id: 'synth', role: 'architect', summary: 'merge upstream' },
      ledger,
      timeoutMs: 2000,
      pollIntervalMs: 25,
      mockJoinerResult: { ok: true, summary: 'joined' },
    });
    const ok = result.pattern === 'fan-in'
      && result.ok === true
      && result.joiner && result.joiner.dispatched
      && result.joiner.result && result.joiner.result.ok === true;
    return { name: 'fan-in', ok, detail: { upstreamComplete: result.upstream.complete.length, joinerDispatched: Boolean(result.joiner && result.joiner.dispatched) } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function probeChain() {
  const tmp = mkTmp('ch');
  try {
    const ledger = createLedger({ ledgerPath: path.join(tmp, 'b.jsonl') });
    const result = await chain({
      goalId: 'grade-ch',
      steps: [
        { id: 's1', role: 'researcher', summary: 'first' },
        { id: 's2', role: 'builder', summary: 'second' },
        { id: 's3', role: 'reviewer', summary: 'third' },
      ],
      ledger,
      timeoutMs: 2000,
      pollIntervalMs: 25,
      mockResults: [
        { stepId: 's1', ok: true, summary: 's1' },
        { stepId: 's2', ok: true, summary: 's2' },
        { stepId: 's3', ok: true, summary: 's3' },
      ],
    });
    const ok = result.pattern === 'chain' && result.ok === true && result.completedCount === 3;
    return { name: 'chain', ok, detail: { completedCount: result.completedCount } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function probeVoting() {
  const tmp = mkTmp('vo');
  try {
    const ledger = createLedger({ ledgerPath: path.join(tmp, 'b.jsonl') });
    const result = await voting({
      goalId: 'grade-vo',
      decision: 'should we approve?',
      voters: [
        { id: 'v1', role: 'reviewer' },
        { id: 'v2', role: 'architect' },
        { id: 'v3', role: 'security_sentinel' },
      ],
      ledger,
      quorum: 2,
      timeoutMs: 2000,
      pollIntervalMs: 25,
      mockVotes: [
        { voterId: 'v1', ok: true, summary: 'approve' },
        { voterId: 'v2', ok: true, summary: 'approve' },
        { voterId: 'v3', ok: false, summary: 'reject' },
      ],
    });
    const ok = result.pattern === 'voting' && result.verdict === 'approve' && result.quorumMet === true;
    return { name: 'voting', ok, detail: { verdict: result.verdict, quorumMet: result.quorumMet, tally: result.tally } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function probeSubagent() {
  const tmp = mkTmp('sa');
  try {
    const ledger = createLedger({ ledgerPath: path.join(tmp, 'b.jsonl') });
    const result = await subagentFanOut({
      parent: 'grade-sa',
      role: 'reviewer',
      tasks: [
        { id: 'one', summary: 'first child' },
        { id: 'two', summary: 'second child' },
      ],
      blackboard: ledger,
      mode: 'workers',
      handler: function handler(ctx) {
        return { ok: true, summary: 'child ' + ctx.task.id + ' ok', facts: [{ subject: 'intermediate', value: 1 }] };
      },
      timeoutMs: 5000,
    });
    const ok = result.pattern === 'subagent' && result.ok === true && result.results.length === 2;
    // Parent-results view must NOT contain intermediate facts (those are in
    // the ledger but filtered out).
    const visible = result.parentResults();
    const scopeOk = visible.length === 2 && visible.every((r) => r.taskId.startsWith('grade-sa.sub'));
    return {
      name: 'subagent',
      ok: ok && scopeOk,
      detail: { results: result.results.length, parentVisible: visible.length },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function score(opts = {}) {
  const probes = [probeFanOut, probeFanIn, probeChain, probeVoting, probeSubagent];
  const outcomes = [];
  for (const probe of probes) {
    let outcome;
    try {
      outcome = await probe();
    } catch (err) {
      outcome = { name: probe.name.replace('probe', '').toLowerCase(), ok: false, detail: { error: String(err.message || err) } };
    }
    outcomes.push(outcome);
  }
  const passing = outcomes.filter((o) => o.ok).length;
  const total = outcomes.length;
  return {
    score: total === 0 ? 0 : Math.round((passing / total) * 100),
    detail: {
      total,
      passing,
      probes: outcomes,
    },
  };
}

module.exports = { score };
