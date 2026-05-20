#!/usr/bin/env node
'use strict';

// Node-native tests for verify-supply-chain-advisory.js.
//
// Each case spawns the verifier as a child process with fixture env vars set
// so the real `npm audit` and `osv-scanner` binaries are never invoked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const verifier = path.join(root, 'release-gate', 'scripts', 'verify-supply-chain-advisory.js');
const fixturesDir = path.join(root, 'release-gate', 'test', 'fixtures');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-chain-test-'));

function fixture(name) {
  return path.join(fixturesDir, name);
}

function writeTmpJson(name, data) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function runVerifier(extraEnv) {
  const env = {
    ...process.env,
    OPENCLAW_SUPPLY_CHAIN_OSV_FORCE_MISSING: '0',
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, report: parsed };
}

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(label + ': expected ' + e + ' got ' + a);
}

function assertTrue(cond, label) {
  if (!cond) throw new Error(label + ': expected truthy');
}

const emptyAllowlist = writeTmpJson('allowlist-empty.json', {
  schema: 'openclaw-frontier.supply-chain-allowlist.v1',
  entries: [],
});

const activeAllowlist = writeTmpJson('allowlist-active.json', {
  schema: 'openclaw-frontier.supply-chain-allowlist.v1',
  entries: [
    {
      id: 'GHSA-xxxx-yyyy-zzzz',
      package: 'example-pkg',
      reason: 'Upstream maintainer has confirmed fix lands next week; risk is mitigated by network egress rules.',
      expires: '2099-01-01T00:00:00Z',
    },
  ],
});

const expiredAllowlist = writeTmpJson('allowlist-expired.json', {
  schema: 'openclaw-frontier.supply-chain-allowlist.v1',
  entries: [
    {
      id: 'GHSA-xxxx-yyyy-zzzz',
      package: 'example-pkg',
      reason: 'Temporary acceptance pending fix.',
      expires: '2000-01-01T00:00:00Z',
    },
  ],
});

test('clean state: ok=true with empty findings', () => {
  const result = runVerifier({
    OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE: fixture('npm-audit-clean.json'),
    OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE: fixture('osv-clean.json'),
    OPENCLAW_SUPPLY_CHAIN_ALLOWLIST: emptyAllowlist,
  });
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.report, 'parsed report');
  assertEqual(result.report.ok, true, 'ok');
  assertEqual(result.report.npmAudit.high, 0, 'npm high');
  assertEqual(result.report.osvScan.high, 0, 'osv high');
  assertEqual(result.report.allowlistApplied.length, 0, 'allowlistApplied');
});

test('HIGH finding without allowlist: ok=false', () => {
  const result = runVerifier({
    OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE: fixture('npm-audit-high.json'),
    OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE: fixture('osv-vuln.json'),
    OPENCLAW_SUPPLY_CHAIN_ALLOWLIST: emptyAllowlist,
  });
  assertEqual(result.exitCode, 1, 'exit code');
  assertTrue(result.report, 'parsed report');
  assertEqual(result.report.ok, false, 'ok');
  assertTrue(result.report.npmAudit.high >= 1, 'npm high count');
  assertTrue(result.report.osvScan.high >= 1, 'osv high count');
  assertEqual(result.report.allowlistApplied.length, 0, 'allowlistApplied');
});

test('HIGH finding with active allowlist: ok=true with allowlistApplied', () => {
  const result = runVerifier({
    OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE: fixture('npm-audit-high.json'),
    OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE: fixture('osv-vuln.json'),
    OPENCLAW_SUPPLY_CHAIN_ALLOWLIST: activeAllowlist,
    OPENCLAW_SUPPLY_CHAIN_NOW: '2026-05-19T00:00:00Z',
  });
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.report, 'parsed report');
  assertEqual(result.report.ok, true, 'ok');
  assertEqual(result.report.npmAudit.high, 0, 'npm high');
  assertEqual(result.report.osvScan.high, 0, 'osv high');
  assertTrue(result.report.allowlistApplied.length >= 1, 'allowlistApplied count');
  const applied = result.report.allowlistApplied[0];
  assertEqual(applied.entry.id, 'GHSA-xxxx-yyyy-zzzz', 'applied entry id');
  assertEqual(applied.entry.package, 'example-pkg', 'applied entry package');
  assertTrue(typeof applied.entry.reason === 'string' && applied.entry.reason.length > 0, 'applied entry reason');
});

test('expired allowlist: ok=false', () => {
  const result = runVerifier({
    OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE: fixture('npm-audit-high.json'),
    OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE: fixture('osv-vuln.json'),
    OPENCLAW_SUPPLY_CHAIN_ALLOWLIST: expiredAllowlist,
    OPENCLAW_SUPPLY_CHAIN_NOW: '2026-05-19T00:00:00Z',
  });
  assertEqual(result.exitCode, 1, 'exit code');
  assertTrue(result.report, 'parsed report');
  assertEqual(result.report.ok, false, 'ok');
  assertEqual(result.report.allowlistApplied.length, 0, 'allowlistApplied');
});

test('osv-scanner missing: ok=true with info finding when npm clean', () => {
  const result = runVerifier({
    OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE: fixture('npm-audit-clean.json'),
    OPENCLAW_SUPPLY_CHAIN_OSV_FORCE_MISSING: '1',
    OPENCLAW_SUPPLY_CHAIN_ALLOWLIST: emptyAllowlist,
  });
  // Ensure no OSV fixture is used.
  assertEqual(result.exitCode, 0, 'exit code');
  assertTrue(result.report, 'parsed report');
  assertEqual(result.report.ok, true, 'ok');
  assertEqual(result.report.osvScan.installed, false, 'osvScan.installed');
  const infoIds = (result.report.info || []).map((f) => f.id);
  assertTrue(infoIds.includes('osv-scanner-not-installed'), 'info finding present');
});

let failed = 0;
const results = [];
for (const c of cases) {
  try {
    c.fn();
    results.push({ name: c.name, ok: true });
  } catch (err) {
    failed += 1;
    results.push({ name: c.name, ok: false, error: String(err.message || err) });
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

const summary = {
  schema: 'openclaw-frontier.supply-chain-advisory-test.v1',
  ok: failed === 0,
  total: cases.length,
  failed,
  results,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(failed === 0 ? 0 : 1);
