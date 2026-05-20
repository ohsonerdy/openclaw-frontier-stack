#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { LexicalVectorIndex, CagPreloadCache, compactTranscript, promotionFilter, MemoryAdapterError } = require('../lib/memory-adapters');

const index = new LexicalVectorIndex();
index.addDocument({ id: 'doc-bus', text: 'Signed bus envelopes carry task and result coordination.', metadata: { kind: 'architecture' } });
index.addDocument({ id: 'doc-memory', text: 'RAG retrieval and CAG preload cache improve task context.', metadata: { kind: 'memory' } });
index.addDocument({ id: 'doc-release', text: 'Release gates require reviewer decisions and verifier output.', metadata: { kind: 'release' } });

const hits = index.search('task context retrieval cache', { limit: 2 });
assert.strictEqual(hits[0].id, 'doc-memory');
assert(hits[0].score > 0);

const cag = new CagPreloadCache();
const put = cag.put({ key: 'frontier-baseline', payload: 'Stable architecture baseline for demo tasks.', sourceIds: ['doc-memory'] });
assert.strictEqual(put.sha256.length, 64);
assert.strictEqual(cag.get('frontier-baseline').sourceIds[0], 'doc-memory');

const compacted = compactTranscript({ id: 'conversation-001', messages: ['Builder claimed task.', 'Reviewer requested verifier output.'], maxChars: 80 });
assert.strictEqual(compacted.sourceCount, 2);
assert.strictEqual(compacted.sha256.length, 64);
assert(compacted.summary.length <= 80);

const bounded = compactTranscript({
  id: 'conversation-002',
  messages: ['A long synthetic discussion about reviewer evidence and release gates that needs compacting.'],
  maxChars: 40,
});
assert(bounded.summary.length <= 40);
assert.throws(() => compactTranscript({ id: 'bad-max', messages: ['short'], maxChars: 20 }), MemoryAdapterError);

assert.strictEqual(promotionFilter({ text: 'Architecture decision: include signed bus.', tags: ['architecture', 'decision'] }).accept, true);
assert.strictEqual(promotionFilter({ text: 'Random transient chat note.', tags: ['chat'] }).accept, false);
assert.strictEqual(promotionFilter({ text: 'Contains token shaped private content.', tags: ['decision'] }).accept, false);
assert.throws(() => index.addDocument({ id: 'bad', text: `Private path ${'/Us'}ers/example should fail.` }), MemoryAdapterError);
assert.throws(() => compactTranscript({
  id: 'unsafe',
  messages: ['Synthetic intro.'.repeat(100), `Private path ${'/Us'}ers/example should fail.`],
  maxChars: 80,
}), MemoryAdapterError);
assert.throws(() => promotionFilter({
  text: `Architecture decision with private path ${'/Us'}ers/example.`,
  tags: ['architecture', 'decision'],
}), MemoryAdapterError);

console.log(JSON.stringify({ ok: true, hits: hits.map((hit) => hit.id), cagHash: put.sha256, compactedBytes: compacted.summary.length }, null, 2));
