#!/usr/bin/env node
'use strict';

/**
 * goal-live-path.test.js — end-to-end live-dispatch integration test.
 *
 * Exercises the LIVE goal-dispatch path (not --mock-agents). The test:
 *
 *   1. Starts an in-process mock model server (node:http) on a local port
 *      that returns canned responses matching the eval-runner's
 *      OpenAI-compatible API shape, including a `usage` block so the
 *      orchestrator can compute a per-goal cost estimate.
 *   2. Sets up a fresh blackboard ledger in a temp dir.
 *   3. Spawns one `bin/openclaw-agent` process per role declared by the
 *      goal fixture, each pointed at the mock server with --max-tasks 1.
 *   4. Spawns `bin/openclaw goal --file <fixture> --blackboard <temp>
 *      --no-mock-agents` and waits for it to exit.
 *   5. Asserts: every lane has a result record on the ledger, the trace
 *      synthesis is ok, the goal-state file shows status=done, the cost
 *      estimate is positive, no active task-claims remain, no
 *      `decision: blocked` records were written.
 *
 * The test runs in <30 seconds (target ~10s) and uses no real network.
 *
 * Run via:  node test/integration/goal-live-path.test.js
 * Exit 0 = success, non-zero with diagnostic output = failure.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OPENCLAW = path.join(REPO_ROOT, 'bin', 'openclaw');
const OPENCLAW_AGENT = path.join(REPO_ROOT, 'bin', 'openclaw-agent');

// ---------- mock model server ----------

function startMockModelServer() {
  let requestCount = 0;
  const responses = [];
  const server = http.createServer((req, res) => {
    requestCount += 1;
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(buf); } catch (_) { /* swallow */ }
      const msgs = (parsed && Array.isArray(parsed.messages)) ? parsed.messages : [];
      const userText = msgs.length ? String(msgs[msgs.length - 1].content || '') : '';
      // Pick a canned reply based on the role in the user prompt.
      let content = `Mock live agent reply to: ${userText.slice(0, 80)}`;
      const lower = userText.toLowerCase();
      if (lower.includes('builder')) content = 'Mock builder: implementation done. Edits stage clean.';
      else if (lower.includes('reviewer')) content = 'Mock reviewer: LGTM. No blockers found in this change.';
      else if (lower.includes('verifier')) content = 'Mock verifier: verify-report shows all checks green.';
      else if (lower.includes('docs')) content = 'Mock docs: doc-diff appended and changelog line added.';
      else if (lower.includes('sentinel')) content = 'Mock sentinel: gate passes. No leakage signals detected.';

      // Canned usage numbers; the orchestrator multiplies by the cost-table
      // rate. Different roles get different sizes so the cost aggregation
      // shows variance.
      const sizeFactor = userText.length;
      const usage = {
        prompt_tokens: 200 + sizeFactor,
        completion_tokens: 80,
        total_tokens: 280 + sizeFactor,
      };

      const body = {
        id: `mock-resp-${requestCount}`,
        object: 'chat.completion',
        model: parsed && parsed.model,
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage,
      };
      responses.push({ req: parsed, res: body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        getRequestCount: () => requestCount,
        getResponses: () => responses.slice(),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------- helpers ----------

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function spawnAgent({ role, blackboardPath, endpoint, maxTasks = 1, timeoutMs = 25000, auditPath, identityKey = null }) {
  const env = {
    ...process.env,
    // Force the OpenAI-compatible auth path to skip auth (localhost endpoints
    // run with no auth in run-skill-evals.js).
    OPENCLAW_EVAL_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENCLAW_EVAL_ENDPOINT: endpoint,
    OPENCLAW_EVAL_API_FORMAT: 'openai',
    OPENCLAW_AGENT_AUDIT_LOG: auditPath,
  };
  const args = [
    OPENCLAW_AGENT,
    '--role', role,
    '--blackboard', blackboardPath,
    '--endpoint', endpoint,
    '--api-format', 'openai',
    '--model', 'mock-model-v1',
    '--max-tasks', String(maxTasks),
    '--poll-interval', '200',
    '--quiet',
  ];
  if (identityKey) args.push('--identity-key', identityKey);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`agent ${role} timed out after ${timeoutMs}ms\nstderr:\n${stderr}\nstdout:\n${stdout}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function spawnGoalHarness({ blackboardPath, goalFile, goalsDir, timeoutMs = 25000 }) {
  const env = { ...process.env };
  const args = [
    OPENCLAW,
    'goal',
    '--file', goalFile,
    '--blackboard', blackboardPath,
    '--no-mock-agents',
    '--max-wait-ms', '20000',
    '--goals-dir', goalsDir,
    '--quiet',
    '--json',
  ];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`goal harness timed out after ${timeoutMs}ms\nstderr:\n${stderr}\nstdout:\n${stdout}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exited };
}

function waitForFile(p, predicate, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          if (predicate(content)) return resolve(content);
        } catch (_) { /* ignore */ }
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${p}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ---------- the test ----------

async function main() {
  console.error('[live-path-test] starting');
  const tempDir = makeTempDir('ofs-live-path-');
  const blackboardPath = path.join(tempDir, 'blackboard.jsonl');
  const goalsDir = path.join(tempDir, '.openclaw', 'goals');
  const auditPath = path.join(tempDir, 'agent-audit.ndjson');
  fs.mkdirSync(goalsDir, { recursive: true });

  // Build a minimal goal fixture that uses only simple (non-pattern) lanes
  // because the live-path test is about the dispatch → result → synthesis
  // loop. Pattern lanes are covered by lib/coordination/test/* unit tests.
  const goalFile = path.join(tempDir, 'goal.json');
  const goalId = `live-test-${Date.now().toString(36)}`;
  const goalFixture = {
    schema: 'openclaw-frontier.goal.v1',
    id: goalId,
    title: 'Live-path integration test fixture',
    status: 'active',
    owner: 'orchestrator',
    source: 'test/integration/goal-live-path.test.js',
    definitionOfDone: 'All lanes return GREEN via live agents.',
    cadence: { operatorUpdateMinutes: 30, channel: 'operator-chat' },
    // Use only roles that have a CONTRACT.md under agents/ — the live agent
    // daemon refuses to start without one. builder/reviewer/researcher are
    // the canonical "small enough to test fast" subset.
    lanes: [
      { name: 'implementation', role: 'builder', summary: 'live-test builder lane', expects: ['patch'] },
      { name: 'review', role: 'reviewer', summary: 'live-test reviewer lane', expects: ['review-decision'] },
      { name: 'research', role: 'researcher', summary: 'live-test researcher lane', expects: ['research-note'] },
    ],
    green: [],
    red: [],
  };
  fs.writeFileSync(goalFile, JSON.stringify(goalFixture, null, 2), 'utf8');
  console.error(`[live-path-test] tempDir=${tempDir}`);

  const server = await startMockModelServer();
  console.error(`[live-path-test] mock model server at ${server.url}`);

  let agentHandles = [];
  let goalHandle = null;
  try {
    // Spawn one agent per role BEFORE the goal harness so they're listening
    // when claims arrive.
    for (const lane of goalFixture.lanes) {
      const h = spawnAgent({
        role: lane.role,
        blackboardPath,
        endpoint: server.url,
        maxTasks: 1,
        timeoutMs: 25000,
        auditPath,
      });
      agentHandles.push({ role: lane.role, handle: h });
    }
    // Give the agents a beat to attach a polling loop before we dispatch.
    await new Promise((r) => setTimeout(r, 300));

    // Spawn the goal harness. The agents will pick the claims off the
    // ledger and write results within the max-wait budget.
    goalHandle = spawnGoalHarness({
      blackboardPath,
      goalFile,
      goalsDir,
      timeoutMs: 25000,
    });
    const harnessExit = await goalHandle.exited;
    console.error(`[live-path-test] harness exited code=${harnessExit.code}`);
    if (harnessExit.code !== 0) {
      throw new Error(`harness exit code ${harnessExit.code}\nstderr:\n${harnessExit.stderr}\nstdout:\n${harnessExit.stdout.slice(0, 4000)}`);
    }
    // All agents should have completed by now (they exit after --max-tasks 1).
    for (const { role, handle } of agentHandles) {
      const exit = await handle.exited;
      if (exit.code !== 0) {
        throw new Error(`agent ${role} exited code ${exit.code}\nstderr:\n${exit.stderr}`);
      }
    }

    // ---------- assertions ----------
    const records = readJsonl(blackboardPath);
    assert.ok(records.length > 0, 'blackboard ledger has at least one record');
    const claims = records.filter((r) => r.kind === 'task-claim');
    const results = records.filter((r) => r.kind === 'result');
    const facts = records.filter((r) => r.kind === 'fact');
    const decisions = records.filter((r) => r.kind === 'decision');

    // One claim per lane (orchestrator wrote them).
    assert.strictEqual(claims.length, goalFixture.lanes.length, `expected ${goalFixture.lanes.length} task-claims; saw ${claims.length}`);
    for (const lane of goalFixture.lanes) {
      const taskId = `${goalId}.${lane.name}`;
      const claim = claims.find((c) => c.taskId === taskId);
      assert.ok(claim, `expected a task-claim for ${taskId}`);
      assert.strictEqual(claim.agent, 'orchestrator', `claim for ${taskId} should be owned by orchestrator`);
    }

    // One result per lane.
    assert.strictEqual(results.length, goalFixture.lanes.length, `expected ${goalFixture.lanes.length} results; saw ${results.length}`);
    for (const lane of goalFixture.lanes) {
      const taskId = `${goalId}.${lane.name}`;
      const result = results.find((r) => r.taskId === taskId);
      assert.ok(result, `expected a result for ${taskId}`);
      assert.strictEqual(result.agent, lane.role, `result for ${taskId} should come from role ${lane.role}`);
      assert.strictEqual(result.ok, true, `result for ${taskId} should be ok=true`);
    }

    // No decision: blocked records.
    const blocked = decisions.filter((d) => d.status === 'blocked');
    assert.strictEqual(blocked.length, 0, `expected zero blocked decisions; saw ${blocked.length}: ${JSON.stringify(blocked)}`);

    // Usage facts: one per lane (the agent writes one when the model returned usage).
    const usageFacts = facts.filter((f) => typeof f.subject === 'string' && f.subject.startsWith('usage:'));
    assert.strictEqual(usageFacts.length, goalFixture.lanes.length, `expected ${goalFixture.lanes.length} usage facts; saw ${usageFacts.length}`);
    for (const fact of usageFacts) {
      assert.ok(fact.value, 'usage fact has a value');
      assert.ok(fact.value.usage, 'usage fact carries a usage block');
      assert.ok(fact.value.model, 'usage fact has a model id');
    }

    // No stale task-claims (every claim has a result).
    for (const claim of claims) {
      const r = results.find((res) => res.taskId === claim.taskId);
      assert.ok(r, `stale task-claim with no matching result: ${claim.taskId}`);
    }

    // Goal state file: exists and shows status=done with positive cost.
    const stateFile = path.join(goalsDir, `${goalId}.json`);
    assert.ok(fs.existsSync(stateFile), `expected state file at ${stateFile}`);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.status, 'done', `state.status expected 'done'; got '${state.status}'`);
    assert.ok(state.cost, 'state has a cost block');
    assert.ok(state.cost.callCount >= goalFixture.lanes.length, `expected at least ${goalFixture.lanes.length} cost-tracked calls; got ${state.cost.callCount}`);
    assert.ok(state.cost.usd > 0, `expected positive cost estimate; got ${state.cost.usd}`);
    // Cost must be reasonable — bounded above to catch a unit error
    // (e.g. treating per-token rate as per-MTok or vice versa).
    assert.ok(state.cost.usd < 0.1, `cost suspiciously high for ${goalFixture.lanes.length} mock calls: $${state.cost.usd}`);

    // Trace JSON: parse the harness stdout and verify shape.
    let trace;
    try { trace = JSON.parse(harnessExit.stdout); }
    catch (err) { throw new Error(`harness stdout was not JSON: ${err.message}\n${harnessExit.stdout.slice(0, 4000)}`); }
    assert.strictEqual(trace.ok, true, `trace.ok expected true; got ${trace.ok}`);
    assert.strictEqual(trace.goalId, goalId, 'trace.goalId matches fixture');
    assert.strictEqual(trace.lanes.length, goalFixture.lanes.length, 'trace.lanes length matches fixture');
    for (const laneTrace of trace.lanes) {
      assert.strictEqual(laneTrace.status, 'done', `lane ${laneTrace.name} should be done; got ${laneTrace.status}`);
    }
    assert.ok(trace.cost && trace.cost.usd > 0, 'trace.cost has a positive estimate');

    // The mock server should have served exactly one request per lane.
    assert.strictEqual(server.getRequestCount(), goalFixture.lanes.length, `mock server expected ${goalFixture.lanes.length} requests; saw ${server.getRequestCount()}`);

    console.error('[live-path-test] all assertions passed');
    return { ok: true, tempDir, goalId, cost: state.cost };
  } finally {
    try { for (const { handle } of agentHandles) handle.child.kill('SIGTERM'); } catch (_) {}
    try { if (goalHandle) goalHandle.child.kill('SIGTERM'); } catch (_) {}
    await server.close();
  }
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(JSON.stringify({ ok: true, summary: 'goal-live-path integration test passed', cost: result.cost, goalId: result.goalId }, null, 2) + '\n');
    process.exit(0);
  }).catch((err) => {
    process.stderr.write(`[live-path-test] FAILED: ${err.stack || err.message || err}\n`);
    process.exit(1);
  });
}

module.exports = { main, startMockModelServer };
