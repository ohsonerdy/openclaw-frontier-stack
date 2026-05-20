#!/usr/bin/env node
'use strict';

// Synthetic local-only OpenClaw Frontier Stack demo.
// No external services, no live credentials, no private runtime data.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const demoKey = 'demo-signing-key-not-for-production';
const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

const blackboard = {
  tasks: {},
  pathClaims: {},
  events: [],
};

const envelopes = [];

function sign(payload) {
  return crypto.createHmac('sha256', demoKey).update(JSON.stringify(payload)).digest('hex');
}

function emit(type, from, to, body, correlationId) {
  const payload = {
    id: `${type.toLowerCase()}-${envelopes.length + 1}`,
    type,
    from,
    to,
    correlationId: correlationId || null,
    ts: now(),
    body,
  };
  envelopes.push({ ...payload, signature: sign(payload) });
  blackboard.events.push({ ts: payload.ts, kind: 'envelope', id: payload.id, type, from, to });
  return payload;
}

function claimTask(agent, taskId, summary) {
  blackboard.tasks[taskId] = { agent, summary, status: 'claimed', claimedAt: now() };
  blackboard.events.push({ ts: now(), kind: 'task-claim', agent, taskId, summary });
}

function claimPath(agent, taskId, filePath) {
  if (blackboard.pathClaims[filePath]) {
    throw new Error(`path already claimed: ${filePath}`);
  }
  blackboard.pathClaims[filePath] = { agent, taskId, claimedAt: now() };
  blackboard.events.push({ ts: now(), kind: 'path-claim', agent, taskId, path: filePath });
}

function finishTask(taskId, artifact) {
  blackboard.tasks[taskId].status = 'done';
  blackboard.tasks[taskId].artifact = artifact;
  blackboard.tasks[taskId].finishedAt = now();
  blackboard.events.push({ ts: now(), kind: 'task-done', taskId, artifact });
}

function memorySearch(query) {
  const corpus = [
    {
      id: 'mem-001',
      text: 'Use path claims before editing shared files so coding agents do not stomp each other.',
    },
    {
      id: 'mem-002',
      text: 'Sentinel must review release artifacts for secrets, private data, and unsafe publish actions.',
    },
    {
      id: 'mem-003',
      text: 'Every TASK should produce a RESULT with artifact paths and a human-readable summary.',
    },
  ];
  return corpus.filter((item) => item.text.toLowerCase().includes(query.toLowerCase().split(' ')[0]));
}

// 1. User request enters Orchestrator.
const userRequest = 'Add a visible health endpoint to the demo app and prepare it for release review.';
const root = emit('TASK', 'user', 'orchestrator', { summary: userRequest, resultContract: 'plan + patch + review + release decision' });
claimTask('orchestrator', root.id, userRequest);

// 2. Orchestrator delegates to Architect.
const architectTask = emit('TASK', 'orchestrator', 'architect', {
  summary: 'Plan demo health endpoint implementation.',
  expectedResult: ['target files', 'risk notes', 'test plan'],
}, root.id);
claimTask('architect', architectTask.id, architectTask.body.summary);
const architectResult = emit('RESULT', 'architect', 'orchestrator', {
  plan: ['edit src/demo-app.js', 'add /health response', 'add smoke test'],
  risks: ['ensure route is synthetic and local-only'],
  testPlan: ['run node examples/demo-swarm/run-demo.js', 'inspect trace artifact'],
}, architectTask.id);
finishTask(architectTask.id, 'architect-plan');

// 3. Orchestrator asks Scout and Builder.
const scoutTask = emit('TASK', 'orchestrator', 'scout', { summary: 'Retrieve coordination rule for shared-file edits.' }, root.id);
claimTask('scout', scoutTask.id, scoutTask.body.summary);
const scoutHits = memorySearch('path claims');
const scoutResult = emit('RESULT', 'scout', 'orchestrator', { hits: scoutHits }, scoutTask.id);
finishTask(scoutTask.id, 'synthetic-memory-hits');

const builderTask = emit('TASK', 'orchestrator', 'builder', { summary: 'Create synthetic patch artifact.' }, root.id);
claimTask('builder', builderTask.id, builderTask.body.summary);
claimPath('builder', builderTask.id, 'src/demo-app.js');
const patchPath = path.join(outDir, 'demo-health-endpoint.patch');
fs.writeFileSync(patchPath, [
  'diff --git a/src/demo-app.js b/src/demo-app.js',
  '+ export function health() {',
  '+   return { ok: true, service: "frontier-orchestrator-demo" };',
  '+ }',
  '',
].join('\n'));
const builderResult = emit('RESULT', 'builder', 'orchestrator', { artifact: path.relative(__dirname, patchPath), sha256: sha(fs.readFileSync(patchPath)) }, builderTask.id);
finishTask(builderTask.id, path.relative(__dirname, patchPath));

// 4. Reviewer validates artifact.
const reviewerTask = emit('TASK', 'orchestrator', 'reviewer', { summary: 'Review synthetic patch artifact.' }, root.id);
claimTask('reviewer', reviewerTask.id, reviewerTask.body.summary);
const reviewerResult = emit('RESULT', 'reviewer', 'orchestrator', {
  verdict: 'PASS',
  notes: ['patch is synthetic', 'no external IO', 'no private data'],
  reviewedArtifact: builderResult.body.artifact,
}, reviewerTask.id);
finishTask(reviewerTask.id, 'review-pass');

// 5. Sentinel gates release.
const sentinelTask = emit('TASK', 'orchestrator', 'sentinel', { summary: 'Run release/privacy gate on synthetic demo outputs.' }, root.id);
claimTask('sentinel', sentinelTask.id, sentinelTask.body.summary);
const sentinelDecision = emit('DECISION', 'sentinel', 'orchestrator', {
  decision: 'APPROVE_RELEASE_CANDIDATE',
  conditions: ['local-only', 'synthetic data only', 'not a GitHub publish approval'],
}, sentinelTask.id);
finishTask(sentinelTask.id, 'sentinel-demo-approval');

// 6. Orchestrator final trace summary.
const finalResult = emit('RESULT', 'orchestrator', 'user', {
  summary: 'Synthetic coding swarm completed with path claim, memory retrieval, patch artifact, review, and Sentinel gate.',
  artifacts: [path.relative(__dirname, patchPath)],
  rootTask: root.id,
  envelopeCount: envelopes.length,
}, root.id);
finishTask(root.id, 'final-summary');

const trace = {
  generatedAt: now(),
  demo: 'openclaw-frontier-stack/demo-swarm',
  userRequest,
  envelopes,
  blackboard,
  integrity: {
    envelopeCount: envelopes.length,
    pathClaimCount: Object.keys(blackboard.pathClaims).length,
    taskCount: Object.keys(blackboard.tasks).length,
    traceSha256: null,
  },
};
trace.integrity.traceSha256 = sha(JSON.stringify({ envelopes, blackboard }));

const tracePath = path.join(outDir, 'trace.json');
const summaryPath = path.join(outDir, 'summary.md');
fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2) + '\n');
fs.writeFileSync(summaryPath, `# Demo swarm trace summary\n\n- Root task: ${root.id}\n- Envelopes: ${envelopes.length}\n- Tasks: ${Object.keys(blackboard.tasks).length}\n- Path claims: ${Object.keys(blackboard.pathClaims).length}\n- Final decision: ${sentinelDecision.body.decision}\n- Trace SHA-256: ${trace.integrity.traceSha256}\n\nArtifacts:\n\n- ${path.relative(__dirname, patchPath)}\n- ${path.relative(__dirname, tracePath)}\n`);

console.log(JSON.stringify({
  ok: true,
  summary: path.relative(process.cwd(), summaryPath),
  trace: path.relative(process.cwd(), tracePath),
  envelopes: envelopes.length,
  tasks: Object.keys(blackboard.tasks).length,
  pathClaims: Object.keys(blackboard.pathClaims).length,
  decision: sentinelDecision.body.decision,
}, null, 2));
