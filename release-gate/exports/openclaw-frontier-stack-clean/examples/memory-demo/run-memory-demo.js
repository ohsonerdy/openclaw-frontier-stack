#!/usr/bin/env node
'use strict';

// Synthetic local-only memory/RAG/CAG/compaction demo.
// No external calls, no live transcripts, no private data.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const corpus = [
  {
    id: 'mem-001',
    title: 'Path claim invariant',
    source: 'memory/coordination/path-claims.md',
    text: 'Before editing a shared file, an agent must claim the path on the blackboard to prevent concurrent edits.',
    tags: ['blackboard', 'coordination', 'coding-swarm'],
  },
  {
    id: 'mem-002',
    title: 'Result contract invariant',
    source: 'memory/orchestration/result-contracts.md',
    text: 'Every TASK should resolve to a RESULT containing a summary, artifact references, and blockers if incomplete.',
    tags: ['taskflow', 'result-contract'],
  },
  {
    id: 'mem-003',
    title: 'Sentinel release boundary',
    source: 'memory/release/sentinel-gates.md',
    text: 'A Sentinel decision can approve a demo artifact, but public upload still requires the owner and all reviewers.',
    tags: ['release-gate', 'security'],
  },
  {
    id: 'mem-004',
    title: 'CAG size guard',
    source: 'memory/context/cag.md',
    text: 'CAG preload must be bounded, deterministic, and regenerated from durable sanitized memory, not raw logs.',
    tags: ['cag', 'compaction'],
  },
];

const noisyTrace = [
  { role: 'user', text: 'Please add the demo health endpoint.' },
  { role: 'orchestrator', text: 'Delegating to Architect and Builder.' },
  { role: 'tool', text: 'large noisy tool output omitted from durable memory' },
  { role: 'architect', text: 'Decision: edit src/demo-app.js and add a local-only health response.' },
  { role: 'builder', text: 'Artifact: out/demo-health-endpoint.patch' },
  { role: 'sentinel', text: 'Decision: APPROVE_RELEASE_CANDIDATE. Public upload still requires 4/4 review and owner approval.' },
  { role: 'chat', text: 'nice, sounds good!!' },
];

function tokenize(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
}

function score(query, doc) {
  const q = tokenize(query);
  const d = tokenize(`${doc.title} ${doc.text} ${doc.tags.join(' ')}`);
  let overlap = 0;
  for (const term of q) if (d.has(term)) overlap += 1;
  return overlap / Math.max(1, q.size);
}

function search(query, limit = 3) {
  return corpus
    .map((doc) => ({ ...doc, score: score(query, doc) }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ id, title, source, text, tags, score }) => ({ id, title, source, excerpt: text, tags, score: Number(score.toFixed(3)) }));
}

function compact(trace) {
  const keep = trace.filter((item) => /Decision:|Artifact:|blocker|requires|claim|RESULT/i.test(item.text));
  return {
    decisions: keep.filter((item) => /Decision:/i.test(item.text)).map((item) => item.text),
    artifacts: keep.filter((item) => /Artifact:/i.test(item.text)).map((item) => item.text.replace(/^Artifact:\s*/i, '')),
    droppedCount: trace.length - keep.length,
  };
}

function promote(item) {
  const durable = /Decision:|Artifact:|requires|must|invariant|blocker/i.test(item.text);
  const filler = /nice|sounds good|lol|thanks/i.test(item.text);
  return { accepted: durable && !filler, reason: durable && !filler ? 'durable-signal' : 'non-durable-or-filler' };
}

const retrieval = {
  query: 'path claim before edit',
  hits: search('path claim before edit'),
};

const cagLines = [
  '# CAG-PRELOAD.example.md',
  '',
  '## Coordination invariants',
  ...corpus.slice(0, 4).map((doc) => `- ${doc.title}: ${doc.text}`),
  '',
];
const cag = cagLines.join('\n');
const cagHash = crypto.createHash('sha256').update(cag).digest('hex');

const compaction = compact(noisyTrace);
const promotions = noisyTrace.map((item) => ({ ...item, promotion: promote(item) }));

const result = {
  ok: true,
  generatedAt: new Date().toISOString(),
  retrieval,
  cag: {
    bytes: Buffer.byteLength(cag),
    sha256: cagHash,
    path: 'out/CAG-PRELOAD.example.md',
  },
  compaction,
  promotions,
  safety: {
    externalCalls: 0,
    privateData: false,
    syntheticOnly: true,
  },
};

fs.writeFileSync(path.join(outDir, 'CAG-PRELOAD.example.md'), cag);
fs.writeFileSync(path.join(outDir, 'memory-demo-result.json'), JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'summary.md'), [
  '# Memory demo summary',
  '',
  `- Retrieval query: ${retrieval.query}`,
  `- Retrieval hits: ${retrieval.hits.length}`,
  `- CAG bytes: ${result.cag.bytes}`,
  `- CAG sha256: ${result.cag.sha256}`,
  `- Compaction dropped noisy items: ${compaction.droppedCount}`,
  `- Accepted promotions: ${promotions.filter((p) => p.promotion.accepted).length}`,
  '- External calls: 0',
  '- Synthetic only: true',
  '',
].join('\n'));

console.log(JSON.stringify({
  ok: true,
  retrievalHits: retrieval.hits.length,
  cagBytes: result.cag.bytes,
  compactionDropped: compaction.droppedCount,
  acceptedPromotions: promotions.filter((p) => p.promotion.accepted).length,
  output: path.relative(process.cwd(), path.join(outDir, 'memory-demo-result.json')),
}, null, 2));
