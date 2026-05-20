'use strict';

/**
 * docs-freshness — for each docs/*.md the category infers a likely source
 * directory and compares last-commit times. If the doc is older than 180 days
 * AND the source has changed since the doc, it's stale.
 *
 * Score = max(0, 100 - stale_count * 10).
 *
 * Operator note: requires git history. When run outside a git checkout the
 * category degrades gracefully — returns score: null with a reason.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STALE_THRESHOLD_DAYS = 180;
const SECONDS_PER_DAY = 86400;

function gitCt(root, rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return Number.parseInt(out, 10) || null;
  } catch { return null; }
}

function gitMostRecentInDir(root, rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', `${rel}/`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return Number.parseInt(out, 10) || null;
  } catch { return null; }
}

// Map a doc filename (relative to docs/) to a probable source dir.
function inferSourceDir(docRel) {
  // Strip leading docs/ and the .md.
  const stem = docRel.replace(/^docs\//, '').replace(/\.md$/, '');
  const candidates = [
    `src/${stem}`,
    `lib/${stem}`,
    `lib/${stem.replace(/-/g, '_')}`,
    `lib/${stem.split('-')[0]}`,
    `src/${stem.split('-')[0]}`,
    `crates/openclaw-${stem.split('-')[0]}`,
  ];
  // Hand-mapped overrides for docs that don't share their name with a directory.
  const overrides = {
    'agent-system': 'agents',
    'agent-roster-manifest': 'agents',
    'agent-daemon': 'bin',
    'delegation-router-policy': 'agents',
    'cron-scheduler': 'cron',
    'webhook-subscriptions': 'webhook',
    'doctor': 'lib/doctor',
    'bundles': 'bundles.json',
    'supply-chain-advisory': 'release-gate/scripts/verify-supply-chain-advisory.js',
    'goal-system': 'src/orchestrator',
    'graph-system': 'src/orchestrator',
    'ticketing': 'src/tickets',
    'orchestration': 'lib/coordination',
    'communication-planes': 'src/signed-bus',
    'bus-and-blackboard-protocol': 'src/blackboard',
    'skill-forge': 'src/skill-forge',
    'fleet-orchestration': 'lib/coordination',
    'memory-rag-cag-compaction': 'src/memory-adapters',
    'mission-control-control-plane': 'examples/mission-control-demo',
    'remote-approval-state-parity': 'src/remote-approval',
    'verification-flow': 'release-gate/scripts',
    'taskflow-result-contracts': 'src/taskflow',
    'fleet-parity-and-soul-baseline': 'agents',
  };
  if (overrides[stem]) return [overrides[stem]];
  return candidates;
}

async function score(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..', '..');
  const docsDir = path.join(root, 'docs');
  if (!fs.existsSync(docsDir)) {
    return { score: null, detail: { reason: 'docs/ directory not found' } };
  }
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { score: null, detail: { reason: 'no .git directory — docs-freshness requires git history' } };
  }
  const entries = fs.readdirSync(docsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'));
  const stale = [];
  const fresh = [];
  const unknown = [];
  for (const entry of entries) {
    const rel = `docs/${entry.name}`;
    const docCt = gitCt(root, rel);
    if (docCt == null) { unknown.push({ doc: rel, reason: 'no git log for doc' }); continue; }
    const candidates = inferSourceDir(rel);
    let sourceCt = null;
    let matchedSource = null;
    for (const c of candidates) {
      const candAbs = path.join(root, c);
      if (!fs.existsSync(candAbs)) continue;
      const ct = fs.statSync(candAbs).isDirectory()
        ? gitMostRecentInDir(root, c)
        : gitCt(root, c);
      if (ct != null && (sourceCt == null || ct > sourceCt)) {
        sourceCt = ct;
        matchedSource = c;
      }
    }
    if (sourceCt == null) {
      // No matchable source. Don't count as stale, but record.
      unknown.push({ doc: rel, reason: 'no source dir matched' });
      continue;
    }
    const ageDays = (sourceCt - docCt) / SECONDS_PER_DAY;
    if (ageDays > STALE_THRESHOLD_DAYS) {
      stale.push({
        doc: rel,
        source: matchedSource,
        docTs: new Date(docCt * 1000).toISOString().slice(0, 10),
        sourceTs: new Date(sourceCt * 1000).toISOString().slice(0, 10),
        ageDays: Math.round(ageDays),
      });
    } else {
      fresh.push({ doc: rel, source: matchedSource, ageDays: Math.round(ageDays) });
    }
  }
  const finalScore = Math.max(0, 100 - stale.length * 10);
  return {
    score: finalScore,
    detail: {
      docsScanned: entries.length,
      staleCount: stale.length,
      freshCount: fresh.length,
      unknownCount: unknown.length,
      staleThresholdDays: STALE_THRESHOLD_DAYS,
      stale: stale.slice(0, 10),
    },
  };
}

module.exports = { score };
