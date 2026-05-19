'use strict';

/**
 * Node-native tests for lib/doctor/.
 *
 * Each test is self-contained and uses a temporary directory under os.tmpdir()
 * so it does not perturb the repository state. The tests assert on the public
 * shape of every check, on the aggregation rule, and on the --no-network
 * short-circuit for modelBackendReachable.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const doctor = require('..');
const checks = require('../checks.js');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-doctor-'));
  fs.mkdirSync(path.join(dir, 'agents', 'architect'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'architect', 'CONTRACT.md'), '# architect\n');
  fs.mkdirSync(path.join(dir, 'agents', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'builder', 'CONTRACT.md'), '# builder\n');
  fs.mkdirSync(path.join(dir, 'release-gate'), { recursive: true });
  return dir;
}

function destroyWorkspace(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shape tests for each check.
// ---------------------------------------------------------------------------

test('nodeVersionOk returns the expected shape', () => {
  const res = checks.nodeVersionOk();
  assert.strictEqual(res.name, 'nodeVersionOk');
  assert.strictEqual(typeof res.ok, 'boolean');
  assert.ok(['info', 'warn', 'error'].includes(res.severity));
  assert.strictEqual(typeof res.detail, 'object');
  // Real test runtime must be >= 20.
  assert.strictEqual(res.ok, true);
});

test('nodeVersionOk flags an old runtime', () => {
  const res = checks.nodeVersionOk({ nodeVersion: '18.19.0' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.severity, 'error');
  assert.strictEqual(res.detail.node, '18.19.0');
});

test('blackboardReachable writes and removes a probe', () => {
  const dir = makeWorkspace();
  try {
    const ledger = path.join(dir, 'release-gate', 'blackboard.jsonl');
    const res = checks.blackboardReachable({ blackboard: ledger });
    assert.strictEqual(res.name, 'blackboardReachable');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.severity, 'info');
    assert.strictEqual(res.detail.writable, true);
    // The probe must have been cleaned up; ledger should be empty or absent.
    if (fs.existsSync(ledger)) {
      const content = fs.readFileSync(ledger, 'utf8');
      assert.strictEqual(content, '', 'probe line was not removed');
    }
  } finally {
    destroyWorkspace(dir);
  }
});

test('blackboardReachable reports a failure when path is unwritable', () => {
  // Use a path under a file (not directory) so mkdir fails.
  const dir = makeWorkspace();
  try {
    const blockingFile = path.join(dir, 'block');
    fs.writeFileSync(blockingFile, 'not-a-directory');
    const res = checks.blackboardReachable({
      blackboard: path.join(blockingFile, 'nested', 'ledger.jsonl'),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.severity, 'error');
  } finally {
    destroyWorkspace(dir);
  }
});

test('signedBusKeysPresent reports unconfigured cleanly', () => {
  const res = checks.signedBusKeysPresent({ identityKey: null, env: {} });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.severity, 'info');
  assert.strictEqual(res.detail.configured, false);
});

test('signedBusKeysPresent validates a real Ed25519 PEM', () => {
  const dir = makeWorkspace();
  try {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyPath = path.join(dir, 'identity.pem');
    fs.writeFileSync(keyPath, pem);
    const res = checks.signedBusKeysPresent({ identityKey: keyPath });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.severity, 'info');
    assert.strictEqual(res.detail.format, 'pem');
    assert.strictEqual(res.detail.asymmetricKeyType, 'ed25519');
    // Key bytes must not appear in the detail payload.
    const dumped = JSON.stringify(res.detail);
    assert.ok(!dumped.includes('BEGIN'), 'PEM body leaked into detail');
  } finally {
    destroyWorkspace(dir);
  }
});

test('signedBusKeysPresent fails on a non-Ed25519 PEM', () => {
  const dir = makeWorkspace();
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyPath = path.join(dir, 'rsa.pem');
    fs.writeFileSync(keyPath, pem);
    const res = checks.signedBusKeysPresent({ identityKey: keyPath });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.severity, 'error');
  } finally {
    destroyWorkspace(dir);
  }
});

test('signedBusKeysPresent fails when the key path is missing', () => {
  const dir = makeWorkspace();
  try {
    const res = checks.signedBusKeysPresent({
      identityKey: path.join(dir, 'does-not-exist.pem'),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.severity, 'error');
    assert.strictEqual(res.detail.exists, false);
  } finally {
    destroyWorkspace(dir);
  }
});

test('roleContractsPresent passes when every role has CONTRACT.md', () => {
  const dir = makeWorkspace();
  try {
    const res = checks.roleContractsPresent({ repoRoot: dir });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.severity, 'info');
    assert.deepStrictEqual(res.detail.roles.sort(), ['architect', 'builder']);
  } finally {
    destroyWorkspace(dir);
  }
});

test('roleContractsPresent fails when a role is missing CONTRACT.md', () => {
  const dir = makeWorkspace();
  try {
    fs.mkdirSync(path.join(dir, 'agents', 'orphan'));
    const res = checks.roleContractsPresent({ repoRoot: dir });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.severity, 'error');
    assert.ok(res.detail.missing.includes('orphan'));
  } finally {
    destroyWorkspace(dir);
  }
});

test('modelBackendConfigured prefers ANTHROPIC_OAUTH_TOKEN', () => {
  const res = checks.modelBackendConfigured({
    env: {
      ANTHROPIC_OAUTH_TOKEN: 'redacted-oauth',
      ANTHROPIC_API_KEY: 'redacted-key',
      OPENAI_API_KEY: 'redacted-openai',
    },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.detail.provider, 'anthropic');
  assert.strictEqual(res.detail.authMethod, 'oauth');
  assert.strictEqual(res.detail.envVar, 'ANTHROPIC_OAUTH_TOKEN');
  // The actual token value must never appear in the detail.
  const dumped = JSON.stringify(res.detail);
  assert.ok(!dumped.includes('redacted-oauth'), 'oauth token leaked into detail');
  assert.ok(!dumped.includes('redacted-key'), 'api key leaked into detail');
});

test('modelBackendConfigured falls back through the priority order', () => {
  const cases = [
    { env: { ANTHROPIC_API_KEY: 'x' }, expectedProvider: 'anthropic', expectedAuth: 'api-key' },
    { env: { OPENCLAW_EVAL_API_KEY: 'x' }, expectedProvider: 'openai-compatible', expectedAuth: 'api-key' },
    { env: { OPENAI_API_KEY: 'x' }, expectedProvider: 'openai', expectedAuth: 'api-key' },
  ];
  for (const c of cases) {
    const res = checks.modelBackendConfigured({ env: c.env });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.detail.provider, c.expectedProvider);
    assert.strictEqual(res.detail.authMethod, c.expectedAuth);
  }
});

test('modelBackendConfigured warns when nothing is configured', () => {
  const res = checks.modelBackendConfigured({ env: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.severity, 'warn');
});

test('modelBackendReachable short-circuits under --no-network', async () => {
  const res = await checks.modelBackendReachable({ noNetwork: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.severity, 'info');
  assert.strictEqual(res.detail.skipped, true);
  assert.strictEqual(res.detail.reason, '--no-network');
});

test('modelBackendReachable skips when no backend resolvable', async () => {
  const res = await checks.modelBackendReachable({ env: {}, noNetwork: false });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.detail.skipped, true);
});

test('verifierLatest reports "not present" when no report exists', () => {
  const dir = makeWorkspace();
  try {
    const res = checks.verifierLatest({ repoRoot: dir });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.severity, 'info');
    assert.strictEqual(res.detail.present, false);
  } finally {
    destroyWorkspace(dir);
  }
});

test('verifierLatest surfaces a prior verifier failure as WARN', () => {
  const dir = makeWorkspace();
  try {
    const reportDir = path.join(dir, 'release-gate', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, 'latest-verification.json'),
      JSON.stringify({
        ok: false,
        generatedAt: '2026-05-19T10:00:00.000Z',
        checks: [{ name: 'foo', ok: false }],
      }) + '\n',
    );
    const res = checks.verifierLatest({ repoRoot: dir });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.severity, 'warn');
    assert.strictEqual(res.detail.verifierOk, false);
    assert.strictEqual(res.detail.checkCount, 1);
  } finally {
    destroyWorkspace(dir);
  }
});

test('ticketStoreOk reports zero tickets for a fresh store', () => {
  const dir = makeWorkspace();
  try {
    const ticketsPath = path.join(dir, 'release-gate', 'tickets.jsonl');
    const res = checks.ticketStoreOk({
      repoRoot: path.resolve(__dirname, '..', '..', '..'),
      ticketsPath,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.detail.total, 0);
    assert.strictEqual(res.detail.openish, 0);
  } finally {
    destroyWorkspace(dir);
  }
});

// ---------------------------------------------------------------------------
// runDoctor aggregation tests.
// ---------------------------------------------------------------------------

test('runDoctor returns ok=true on a healthy workspace', async () => {
  const dir = makeWorkspace();
  try {
    const report = await doctor.runDoctor({
      repoRoot: path.resolve(__dirname, '..', '..', '..'),
      blackboard: path.join(dir, 'release-gate', 'blackboard.jsonl'),
      ticketsPath: path.join(dir, 'release-gate', 'tickets.jsonl'),
      noNetwork: true,
      env: { ANTHROPIC_API_KEY: 'x' },
    });
    assert.strictEqual(report.schema, 'openclaw-frontier.doctor-report.v1');
    assert.strictEqual(typeof report.generatedAt, 'string');
    assert.ok(Array.isArray(report.checks));
    assert.strictEqual(report.checks.length, doctor.CHECK_ORDER.length);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.summary.total, doctor.CHECK_ORDER.length);
    // Every check must carry the four required fields.
    for (const c of report.checks) {
      assert.strictEqual(typeof c.name, 'string');
      assert.strictEqual(typeof c.ok, 'boolean');
      assert.ok(['info', 'warn', 'error'].includes(c.severity));
      assert.strictEqual(typeof c.detail, 'object');
    }
  } finally {
    destroyWorkspace(dir);
  }
});

test('runDoctor flips ok=false when an error-severity check fails', async () => {
  // Use a missing agents directory inside an empty repoRoot to force
  // roleContractsPresent to error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-doctor-empty-'));
  try {
    const report = await doctor.runDoctor({
      repoRoot: dir,
      blackboard: path.join(dir, 'release-gate', 'blackboard.jsonl'),
      ticketsPath: path.join(dir, 'release-gate', 'tickets.jsonl'),
      noNetwork: true,
      env: { ANTHROPIC_API_KEY: 'x' },
    });
    assert.strictEqual(report.ok, false);
    const role = report.checks.find((c) => c.name === 'roleContractsPresent');
    assert.ok(role, 'roleContractsPresent missing');
    assert.strictEqual(role.ok, false);
    assert.strictEqual(role.severity, 'error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDoctor stays ok=true when only warnings fail', async () => {
  const dir = makeWorkspace();
  try {
    // Force the model-backend check to WARN (nothing configured), but every
    // ERROR-severity check passes.
    const report = await doctor.runDoctor({
      repoRoot: path.resolve(__dirname, '..', '..', '..'),
      blackboard: path.join(dir, 'release-gate', 'blackboard.jsonl'),
      ticketsPath: path.join(dir, 'release-gate', 'tickets.jsonl'),
      noNetwork: true,
      env: {},
    });
    const backend = report.checks.find((c) => c.name === 'modelBackendConfigured');
    assert.strictEqual(backend.ok, false);
    assert.strictEqual(backend.severity, 'warn');
    assert.strictEqual(report.ok, true);
  } finally {
    destroyWorkspace(dir);
  }
});

test('formatHumanReadable produces a readable summary', async () => {
  const dir = makeWorkspace();
  try {
    const report = await doctor.runDoctor({
      repoRoot: path.resolve(__dirname, '..', '..', '..'),
      blackboard: path.join(dir, 'release-gate', 'blackboard.jsonl'),
      ticketsPath: path.join(dir, 'release-gate', 'tickets.jsonl'),
      noNetwork: true,
      env: { ANTHROPIC_API_KEY: 'x' },
    });
    const text = doctor.formatHumanReadable(report);
    assert.ok(text.includes('openclaw doctor:'));
    assert.ok(text.includes('nodeVersionOk'));
    assert.ok(text.includes('blackboardReachable'));
  } finally {
    destroyWorkspace(dir);
  }
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

(async function main() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`ok  ${name}\n`);
    } catch (err) {
      fail += 1;
      failures.push({ name, err });
      process.stdout.write(`FAIL ${name}: ${err && err.message ? err.message : err}\n`);
    }
  }
  process.stdout.write(`\n${pass}/${TESTS.length} passed, ${fail} failed\n`);
  if (fail > 0) {
    for (const f of failures) {
      if (f.err && f.err.stack) process.stderr.write(`\n${f.name}:\n${f.err.stack}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
