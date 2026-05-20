#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  createDemoAdapter,
  IntegrationAdapterError,
  MockMcpAdapter,
  ToolTrajectoryLog,
  scoreToolTrajectory,
} = require('../lib/mock-mcp-adapter');

(async () => {
  const adapter = createDemoAdapter();
  assert.deepStrictEqual(adapter.listTools().tools, ['artifact.summarize', 'knowledge.search']);

  const search = await adapter.callTool('knowledge.search', { query: 'blackboard claims' });
  assert.strictEqual(search.ok, true);
  assert.strictEqual(search.result.hits[0].id, 'doc-blackboard');

  const summary = await adapter.callTool('artifact.summarize', { title: 'Demo artifact', body: 'This artifact is synthetic and local only.' });
  assert.strictEqual(summary.result.title, 'Demo artifact');
  assert(summary.result.summary.includes('synthetic'));

  const trajectory = adapter.getToolTrajectory();
  assert.strictEqual(trajectory.schema, 'openclaw-frontier.mcp-tool-trajectory.v1');
  assert.strictEqual(trajectory.records.length, 2);
  assert.deepStrictEqual(trajectory.records.map((entry) => entry.sequence), [1, 2]);
  assert.deepStrictEqual(trajectory.records.map((entry) => entry.status), ['ok', 'ok']);
  assert(trajectory.records.every((entry) => Number.isInteger(entry.latencyMs) && entry.latencyMs >= 0));
  assert(trajectory.records.every((entry) => entry.inputSha256 && !entry.inputSha256.includes('blackboard')));
  assert(trajectory.records.every((entry) => entry.artifacts.length > 0));
  assert(trajectory.reliability.score >= 0.9);
  assert.strictEqual(trajectory.reliability.label, 'high');

  await assert.rejects(() => adapter.callTool('missing.tool', {}), IntegrationAdapterError);
  const failedTrajectory = adapter.getToolTrajectory();
  assert.strictEqual(failedTrajectory.records[2].status, 'error');
  assert.strictEqual(failedTrajectory.records[2].error.code, 'INTEGRATION_ADAPTER_VALIDATION');

  await assert.rejects(() => adapter.callTool('knowledge.search', { query: `see http://${['10','0','0','1'].join('.')}/private` }), IntegrationAdapterError);
  assert.throws(() => new MockMcpAdapter().registerTool('Bad Tool', () => ({})), IntegrationAdapterError);

  const customLog = new ToolTrajectoryLog({ traceId: 'demo-custom-trace' });
  const customAdapter = new MockMcpAdapter({
    trajectoryLog: customLog,
    tools: {
      'demo.ok': () => ({ ok: true, artifacts: [{ id: 'demo-output', type: 'json', path: 'examples/synthetic/demo-output.json' }] }),
    },
  });
  await customAdapter.callTool('demo.ok', {});
  assert.strictEqual(customAdapter.getToolTrajectory().traceId, 'demo-custom-trace');

  const unsafeAsyncAdapter = new MockMcpAdapter({
    tools: {
      'unsafe.async': async () => ({ note: `do not leak http://${['10','0','0','1'].join('.')}/secret` }),
    },
  });
  await assert.rejects(() => unsafeAsyncAdapter.callTool('unsafe.async', {}), IntegrationAdapterError);
  assert.strictEqual(unsafeAsyncAdapter.getToolTrajectory().records[0].status, 'error');

  const lowScore = scoreToolTrajectory([{ sequence: 1, status: 'error', latencyMs: 6000, artifacts: [] }]);
  assert(lowScore.score < 0.4);

  console.log(JSON.stringify({
    ok: true,
    tools: adapter.listTools().tools,
    firstHit: search.result.hits[0].id,
    trajectoryRecords: adapter.getToolTrajectory().records.length,
    reliability: adapter.getToolTrajectory().reliability.label,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
