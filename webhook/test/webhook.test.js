#!/usr/bin/env node
'use strict';

/**
 * webhook/test/webhook.test.js — node-native unit + integration tests for
 * the webhook server. No third-party test framework; uses `assert` plus
 * the built-in `node:test` runner where available.
 *
 * Covered cases:
 *   - HMAC signature accept / reject
 *   - subscription matching by path + event type
 *   - subscription matching wildcard
 *   - transform output shape for each registered transform
 *   - blackboard task-claim is written on success
 *   - malformed body returns 400 and writes nothing
 *   - missing subscription returns 404
 *   - method != POST returns 405
 *   - missing secret returns 401
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createLedger } = require(path.join('..', '..', 'src', 'blackboard', 'lib', 'ledger.js'));
const { createServer } = require('../lib/server.js');
const { loadSubscriptions, matchSubscription, SubscriptionError } = require('../lib/subscriptions.js');
const { transforms } = require('../lib/transforms.js');

function makeTempLedger() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-webhook-'));
  return {
    dir: tmp,
    ledger: createLedger({ ledgerPath: path.join(tmp, 'blackboard.jsonl') }),
    ledgerPath: path.join(tmp, 'blackboard.jsonl'),
  };
}

function hmacHex(body, secret, algo = 'sha256') {
  return crypto.createHmac(algo, secret).update(body).digest('hex');
}

async function startServer(subscriptions, ledger, envOverrides = {}, onProcessed) {
  const env = { ...process.env, ...envOverrides };
  const audits = [];
  const server = createServer({
    subscriptions,
    ledger,
    env,
    audit: (rec) => audits.push(rec),
    onProcessed,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port, audits };
}

function postJson(port, urlPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port,
      path: urlPath,
      headers: { 'content-type': 'application/json', 'content-length': bodyBuffer.length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }
        resolve({ status: res.statusCode, body: json, raw: text });
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

const BASE_SUBSCRIPTIONS = [
  {
    id: 'gh-pr',
    path: '/webhook/github/pr',
    eventType: 'pull_request',
    secretEnv: 'TEST_SECRET_GH',
    role: 'reviewer',
    subject: 'webhook:github-pr',
    bodyTransform: 'github-pr',
    signatureAlgo: 'sha256',
    signatureHeader: 'x-hub-signature-256',
    eventHeader: 'x-github-event',
  },
  {
    id: 'generic',
    path: '/webhook/generic',
    eventType: '*',
    secretEnv: 'TEST_SECRET_GENERIC',
    role: 'architect',
    subject: 'webhook:generic',
    bodyTransform: 'generic-json',
    signatureAlgo: 'sha256',
    signatureHeader: 'x-signature-256',
    eventHeader: 'x-event-type',
  },
];

// ---------------------------------------------------------------------------
// Pure-module tests
// ---------------------------------------------------------------------------

test('subscriptions loader rejects unknown bodyTransform', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-webhook-subs-'));
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({
    subscriptions: [{
      id: 'bad', path: '/x', eventType: 'push',
      secretEnv: 'TEST_SECRET', role: 'reviewer',
      subject: 'webhook:bad', bodyTransform: 'unknown-shape',
    }],
  }));
  assert.throws(() => loadSubscriptions(file), SubscriptionError);
});

test('subscriptions loader accepts a valid file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-webhook-subs-'));
  const file = path.join(tmp, 'good.json');
  fs.writeFileSync(file, JSON.stringify({
    subscriptions: [{
      id: 'ok', path: '/x', eventType: 'push',
      secretEnv: 'TEST_SECRET', role: 'reviewer',
      subject: 'webhook:ok', bodyTransform: 'github-push',
    }],
  }));
  const subs = loadSubscriptions(file);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].id, 'ok');
  assert.equal(subs[0].signatureHeader, 'x-hub-signature-256');
});

test('matchSubscription matches path + event header', () => {
  const sub = matchSubscription(BASE_SUBSCRIPTIONS, {
    url: '/webhook/github/pr',
    headers: { 'x-github-event': 'pull_request' },
  });
  assert.ok(sub);
  assert.equal(sub.id, 'gh-pr');
});

test('matchSubscription falls back to wildcard event', () => {
  const sub = matchSubscription(BASE_SUBSCRIPTIONS, {
    url: '/webhook/generic',
    headers: { 'x-event-type': 'anything-goes' },
  });
  assert.ok(sub);
  assert.equal(sub.id, 'generic');
});

test('matchSubscription rejects wrong path', () => {
  const sub = matchSubscription(BASE_SUBSCRIPTIONS, {
    url: '/webhook/unknown',
    headers: { 'x-github-event': 'pull_request' },
  });
  assert.equal(sub, null);
});

test('transforms: github-pr extracts only public fields', () => {
  const body = transforms['github-pr']({
    action: 'opened',
    number: 42,
    pull_request: { number: 42, title: 'Demo title', body: 'should not leak' },
    repository: { full_name: 'owner/repo', private: false },
    sender: { login: 'someone', id: 9, type: 'User' },
  });
  assert.deepEqual(body, {
    source: 'github-pr',
    repository: 'owner/repo',
    action: 'opened',
    number: 42,
    title: 'Demo title',
  });
});

test('transforms: github-issue drops sender + html_url', () => {
  const body = transforms['github-issue']({
    action: 'labeled',
    issue: { number: 7, title: 'Issue title', html_url: 'should not leak' },
    repository: { full_name: 'o/r' },
  });
  assert.equal(body.repository, 'o/r');
  assert.equal(body.number, 7);
  assert.equal(body.title, 'Issue title');
  assert.equal(body.source, 'github-issue');
  assert.equal(body.html_url, undefined);
});

test('transforms: github-push reports ref and commit count', () => {
  const body = transforms['github-push']({
    ref: 'refs/heads/main',
    commits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    repository: { full_name: 'o/r' },
  });
  assert.equal(body.source, 'github-push');
  assert.equal(body.action, 'push');
  assert.equal(body.ref, 'refs/heads/main');
  assert.equal(body.commits, 3);
});

test('transforms: generic-json refuses non-object payloads', () => {
  assert.throws(() => transforms['generic-json']('a string'), /payload-not-object/);
  assert.throws(() => transforms['generic-json']([1, 2, 3]), /payload-not-object/);
});

// ---------------------------------------------------------------------------
// Server integration tests
// ---------------------------------------------------------------------------

test('valid HMAC PR webhook writes a task-claim and a fact', async () => {
  const { ledger, ledgerPath } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const payload = {
      action: 'opened',
      number: 99,
      pull_request: { number: 99, title: 'New feature' },
      repository: { full_name: 'o/r' },
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = `sha256=${hmacHex(body, 'shhh')}`;
    const res = await postJson(port, '/webhook/github/pr', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sig,
    }, body);
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.taskId);

    const records = ledger.readRecords();
    const claim = records.find((r) => r.kind === 'task-claim');
    assert.ok(claim, 'task-claim was written');
    assert.equal(claim.forRole, 'reviewer');
    const fact = records.find((r) => r.kind === 'fact');
    assert.ok(fact, 'fact record was written');
    assert.equal(fact.value.body.source, 'github-pr');
    assert.equal(fact.value.body.title, 'New feature');
    // The fact value MUST NOT contain the original raw payload's "sender"
    // or any field beyond the transform's public projection.
    assert.equal(fact.value.body.sender, undefined);
    assert.ok(fs.existsSync(ledgerPath));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('bad HMAC returns 401 and writes nothing', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
    const res = await postJson(port, '/webhook/github/pr', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': 'sha256=00deadbeef',
    }, body);
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'signature-mismatch');
    assert.equal(ledger.readRecords().length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('malformed JSON returns 400', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const body = Buffer.from('{this is not json', 'utf8');
    const sig = `sha256=${hmacHex(body, 'shhh')}`;
    const res = await postJson(port, '/webhook/github/pr', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sig,
    }, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid-json');
    assert.equal(ledger.readRecords().length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('missing subscription returns 404', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const body = Buffer.from(JSON.stringify({}), 'utf8');
    const res = await postJson(port, '/webhook/does-not-exist', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': `sha256=${hmacHex(body, 'shhh')}`,
    }, body);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'no-matching-subscription');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('GET returns 405 method-not-allowed', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'GET',
        host: '127.0.0.1', port,
        path: '/webhook/github/pr',
      }, (r) => {
        const cs = []; r.on('data', (c) => cs.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(cs).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 405);
    assert.equal(res.body.error, 'method-not-allowed');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('missing secret env var returns 401', async () => {
  const { ledger } = makeTempLedger();
  // Do not set TEST_SECRET_GH.
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GENERIC: 'shhh-2' },
  );
  // Clear in case parent process set it.
  const originalEnv = process.env.TEST_SECRET_GH;
  delete process.env.TEST_SECRET_GH;
  try {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
    const res = await postJson(port, '/webhook/github/pr', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': `sha256=${hmacHex(body, 'whatever')}`,
    }, body);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'secret-not-configured');
  } finally {
    if (originalEnv !== undefined) process.env.TEST_SECRET_GH = originalEnv;
    await new Promise((r) => server.close(r));
  }
});

test('generic-json wildcard subscription accepts any event header', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'top-secret' },
  );
  try {
    const payload = { subject: 'deploy.completed', id: 'dep-1', priority: 'high', title: 'Deploy ok' };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = `sha256=${hmacHex(body, 'top-secret')}`;
    const res = await postJson(port, '/webhook/generic', {
      'x-event-type': 'arbitrary',
      'x-signature-256': sig,
    }, body);
    assert.equal(res.status, 202);
    const fact = ledger.readRecords().find((r) => r.kind === 'fact');
    assert.ok(fact);
    assert.equal(fact.value.body.source, 'generic-json');
    assert.equal(fact.value.body.subject, 'deploy.completed');
    assert.equal(fact.value.body.priority, 'high');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('error responses never echo payload bytes', async () => {
  const { ledger } = makeTempLedger();
  const { server, port } = await startServer(
    BASE_SUBSCRIPTIONS,
    ledger,
    { TEST_SECRET_GH: 'shhh', TEST_SECRET_GENERIC: 'shhh-2' },
  );
  try {
    const sneaky = '{"injected": "ATTACKER_PAYLOAD_TOKEN_xyz"}';
    const body = Buffer.from(sneaky, 'utf8');
    const res = await postJson(port, '/webhook/github/pr', {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': 'sha256=00deadbeef',
    }, body);
    assert.equal(res.status, 401);
    assert.equal(res.raw.includes('ATTACKER_PAYLOAD_TOKEN_xyz'), false,
      'error response must not echo the inbound payload');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
