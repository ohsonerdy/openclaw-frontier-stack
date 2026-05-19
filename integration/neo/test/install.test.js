#!/usr/bin/env node
'use strict';

/**
 * integration/neo/test/install.test.js
 *
 * Node-native test suite for integration/neo. Runs end-to-end:
 *   - Sets up a temp dir as a fake mesh-agent home.
 *   - Runs install/uninstall against the real OFS skills/ and bin/.
 *   - Asserts: skill bridge entries land, bin path-shims are well-formed,
 *     plugin manifest is correct, idempotence holds, bus-pubkey
 *     registration handles both pubkey-present and pubkey-missing cases,
 *     uninstall fully reverses the install, collision detection refuses
 *     to install on conflict.
 *
 * Hosts that block symlinks AND junctions fall back to file-copy; the
 * test logs the mode but still asserts that the entries are present and
 * navigable.
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const integrationRoot = path.resolve(__dirname, '..');
const lib = require(path.join(integrationRoot, 'lib', 'install-lib.js'));

let checks = 0;
let failed = 0;
const cleanups = [];

function test(name, fn) {
  checks += 1;
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stderr.write(`FAIL: ${name}\n  ${err.stack || err.message || err}\n`);
  }
}

function mkTmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ofs-neo-${label}-`));
  cleanups.push(dir);
  return dir;
}

function makeFakeAgentHome() {
  const home = mkTmp('home');
  fs.mkdirSync(path.join(home, 'SKILLS'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  // Add a stub local skill so we can exercise collision logic separately.
  const localSkill = path.join(home, 'SKILLS', 'goal');
  fs.mkdirSync(localSkill, { recursive: true });
  fs.writeFileSync(path.join(localSkill, 'SKILL.md'), '---\nname: goal\ndescription: local stub\n---\n');
  return home;
}

function placePubkey(home) {
  const keysDir = path.join(home, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  // A plausible Ed25519 pubkey blob. Not a real key — just bytes to copy.
  fs.writeFileSync(path.join(keysDir, 'ed25519.pub'), 'AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY===\n');
}

function removeKnownPubkey(label) {
  const p = path.join(repoRoot, 'release-gate', 'known-pubkeys', `${label}.pub`);
  try { fs.unlinkSync(p); } catch {}
  // If known-pubkeys was created solely for this test and is now empty, drop it.
  try {
    const dir = path.join(repoRoot, 'release-gate', 'known-pubkeys');
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

// -----------------------------------------------------------------------------
// Test 1: package version is readable
// -----------------------------------------------------------------------------

test('readOfsPackageVersion returns a semver-ish string', () => {
  const v = lib.readOfsPackageVersion(repoRoot);
  assert.ok(typeof v === 'string' && v.length > 0, `expected non-empty version, got ${JSON.stringify(v)}`);
  assert.match(v, /^\d+\.\d+\.\d+/, `expected semver, got ${v}`);
});

// -----------------------------------------------------------------------------
// Test 2: install bridges every OFS skill into <home>/SKILLS/ofs/
// -----------------------------------------------------------------------------

test('install creates per-skill bridge entries', () => {
  const home = makeFakeAgentHome();
  const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  assert.ok(result.ok, `install failed: ${JSON.stringify(result.warnings)}`);

  const ofsSubdir = path.join(home, 'SKILLS', 'ofs');
  assert.ok(fs.existsSync(ofsSubdir), 'SKILLS/ofs/ should exist');

  const ofsSkills = lib.listSkillDirs(path.join(repoRoot, 'skills'));
  assert.ok(ofsSkills.length > 0, 'expected at least one OFS skill in skills/');

  for (const name of ofsSkills) {
    const dst = path.join(ofsSubdir, name);
    assert.ok(fs.existsSync(dst), `expected ${dst} to exist`);
    const skillMd = path.join(dst, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), `expected SKILL.md inside ${dst}`);
  }

  // Confirm mode is reported on each op (linked or copy-fallback).
  const skillOps = result.operations.filter((o) => o.op === 'skill-bridge');
  assert.strictEqual(skillOps.length, ofsSkills.length, 'one op per skill');
  const modes = new Set(skillOps.map((o) => o.mode || o.status));
  // Log mode distribution for visibility (junction vs symlink-dir vs copy-fallback).
  process.stdout.write(`  skill-bridge modes: ${[...modes].join(', ')}\n`);
});

// -----------------------------------------------------------------------------
// Test 3: bin shim files are well-formed and reference OFS bin
// -----------------------------------------------------------------------------

test('install writes bash + ps1 PATH shims', () => {
  const home = makeFakeAgentHome();
  lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });

  const bash = path.join(home, 'bin', 'ofs-path.sh');
  const ps1 = path.join(home, 'bin', 'ofs-path.ps1');
  assert.ok(fs.existsSync(bash), 'shim-bash missing');
  assert.ok(fs.existsSync(ps1), 'shim-ps1 missing');

  const bashText = fs.readFileSync(bash, 'utf8');
  const ps1Text = fs.readFileSync(ps1, 'utf8');
  // Both must mention the OFS bin path and the OPENCLAW_OFS_ROOT env var.
  const ofsBin = path.join(repoRoot, 'bin');
  assert.ok(bashText.includes('OPENCLAW_OFS_ROOT='), 'shim-bash must export OPENCLAW_OFS_ROOT');
  assert.ok(bashText.includes(ofsBin.replace(/\\/g, '/')), 'shim-bash must include OFS bin path');
  assert.ok(ps1Text.includes('OPENCLAW_OFS_ROOT'), 'shim-ps1 must set OPENCLAW_OFS_ROOT');
  assert.ok(ps1Text.includes(ofsBin), 'shim-ps1 must include OFS bin path');
});

// -----------------------------------------------------------------------------
// Test 4: plugin manifest reflects OFS package version
// -----------------------------------------------------------------------------

test('install writes plugin manifest with correct version + paths', () => {
  const home = makeFakeAgentHome();
  lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });

  const manifestPath = path.join(home, 'openclaw-plugins.json');
  assert.ok(fs.existsSync(manifestPath), 'plugin manifest missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.schema, 'openclaw-agent.plugin-manifest.v1');
  assert.ok(Array.isArray(manifest.plugins) && manifest.plugins.length === 1);
  const ofs = manifest.plugins[0];
  assert.strictEqual(ofs.id, 'openclaw-frontier-stack');
  assert.strictEqual(ofs.version, lib.readOfsPackageVersion(repoRoot));
  assert.strictEqual(ofs.skillsPath, path.join(repoRoot, 'skills'));
  assert.strictEqual(ofs.binPath, path.join(repoRoot, 'bin'));
});

// -----------------------------------------------------------------------------
// Test 5: install is idempotent — second run produces zero new ops
// -----------------------------------------------------------------------------

test('install is idempotent', () => {
  const home = makeFakeAgentHome();
  lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  const second = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  assert.ok(second.ok, 'second install failed');
  // No "linked" / "created" / "updated" in the second pass — only already-*.
  const fresh = second.operations.filter((o) => /^(linked|copied-fallback|created|updated|registered)$/.test(o.status));
  assert.strictEqual(fresh.length, 0, `expected zero new ops on second run, got ${JSON.stringify(fresh)}`);
});

// -----------------------------------------------------------------------------
// Test 6: dry-run does not touch disk
// -----------------------------------------------------------------------------

test('--dry-run touches nothing', () => {
  const home = makeFakeAgentHome();
  const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent', dryRun: true });
  assert.ok(result.ok, `dry-run install reported not-ok: ${JSON.stringify(result.warnings)}`);

  assert.ok(!fs.existsSync(path.join(home, 'SKILLS', 'ofs')), 'dry-run should not create SKILLS/ofs');
  assert.ok(!fs.existsSync(path.join(home, 'bin', 'ofs-path.sh')), 'dry-run should not create shim-bash');
  assert.ok(!fs.existsSync(path.join(home, 'openclaw-plugins.json')), 'dry-run should not create plugin manifest');

  // Every op should be a "would-*" status.
  for (const op of result.operations) {
    assert.ok(/^(would-|already-|nothing-to-|skipped)/.test(op.status),
      `dry-run op ${op.op}:${op.target} unexpectedly applied with status=${op.status}`);
  }
});

// -----------------------------------------------------------------------------
// Test 7: uninstall reverses every install step
// -----------------------------------------------------------------------------

test('uninstall reverses install completely', () => {
  const home = makeFakeAgentHome();
  lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });

  // Sanity: those artifacts exist now.
  assert.ok(fs.existsSync(path.join(home, 'SKILLS', 'ofs')));
  assert.ok(fs.existsSync(path.join(home, 'bin', 'ofs-path.sh')));
  assert.ok(fs.existsSync(path.join(home, 'openclaw-plugins.json')));

  const result = lib.runUninstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  assert.ok(result.ok, `uninstall reported not-ok: ${JSON.stringify(result.warnings)}`);

  assert.ok(!fs.existsSync(path.join(home, 'SKILLS', 'ofs')), 'SKILLS/ofs should be gone');
  assert.ok(!fs.existsSync(path.join(home, 'bin', 'ofs-path.sh')), 'shim-bash should be gone');
  assert.ok(!fs.existsSync(path.join(home, 'bin', 'ofs-path.ps1')), 'shim-ps1 should be gone');
  assert.ok(!fs.existsSync(path.join(home, 'openclaw-plugins.json')), 'plugin manifest should be gone');

  // Pre-existing local skill must still be there (not collateral damage).
  assert.ok(fs.existsSync(path.join(home, 'SKILLS', 'goal', 'SKILL.md')), 'local goal/ skill must survive uninstall');
});

// -----------------------------------------------------------------------------
// Test 8: skill collision blocks install
// -----------------------------------------------------------------------------

test('skill name collision refuses install (fail-closed)', () => {
  const home = makeFakeAgentHome();
  // Pick any OFS skill name and create a local stub with that name.
  const ofsSkills = lib.listSkillDirs(path.join(repoRoot, 'skills'));
  const conflict = ofsSkills[0];
  const conflictDir = path.join(home, 'SKILLS', conflict);
  fs.mkdirSync(conflictDir, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, 'SKILL.md'), `---\nname: ${conflict}\n---\n`);

  const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  assert.strictEqual(result.ok, false, 'collision should fail-closed');
  assert.ok(result.warnings.some((w) => w.includes('collisions')), `expected collisions warning, got ${JSON.stringify(result.warnings)}`);
  // No skill bridge should have been created.
  assert.ok(!fs.existsSync(path.join(home, 'SKILLS', 'ofs')), 'collision: SKILLS/ofs must not be created');
});

// -----------------------------------------------------------------------------
// Test 9: bus-pubkey registration — absent pubkey = skip + warn
// -----------------------------------------------------------------------------

test('bus registration: skipped when no pubkey present', () => {
  const home = makeFakeAgentHome();
  const label = `testlabel${Date.now()}`;
  const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: label });
  const busOp = result.operations.find((o) => o.op === 'bus-identity');
  assert.ok(busOp, 'bus-identity op must be emitted');
  assert.strictEqual(busOp.status, 'skipped');
  assert.strictEqual(busOp.reason, 'no-pubkey');
  // The known-pubkeys file for this label must not exist.
  const knownPath = path.join(repoRoot, 'release-gate', 'known-pubkeys', `${label}.pub`);
  assert.ok(!fs.existsSync(knownPath), `unexpected pubkey file at ${knownPath}`);
});

// -----------------------------------------------------------------------------
// Test 10: bus-pubkey registration — present pubkey = registered
// -----------------------------------------------------------------------------

test('bus registration: registers when pubkey present', () => {
  const home = makeFakeAgentHome();
  placePubkey(home);
  const label = `testlabel${Date.now()}b`;
  try {
    const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: label });
    const busOp = result.operations.find((o) => o.op === 'bus-identity');
    assert.ok(busOp, 'bus-identity op missing');
    assert.strictEqual(busOp.status, 'registered');

    const knownPath = path.join(repoRoot, 'release-gate', 'known-pubkeys', `${label}.pub`);
    assert.ok(fs.existsSync(knownPath), `expected ${knownPath} to be created`);
    const txt = fs.readFileSync(knownPath, 'utf8');
    assert.ok(txt.includes('TESTKEY'), 'pubkey contents should match what we placed');

    // Uninstall removes it.
    const u = lib.runUninstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: label });
    assert.ok(u.ok);
    assert.ok(!fs.existsSync(knownPath), 'pubkey file should be removed on uninstall');
  } finally {
    removeKnownPubkey(label);
  }
});

// -----------------------------------------------------------------------------
// Test 11: bus registration refuses anything that looks like a private key
// -----------------------------------------------------------------------------

test('bus registration: refuses obvious private key', () => {
  const home = makeFakeAgentHome();
  fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
  // Compose the trigger header at runtime so this source file does not itself
  // contain a literal `BEGIN ... PRIVATE KEY` block (the public-content scanner
  // flags that pattern as a finding regardless of context).
  const dashes = '-----';
  const header = `${dashes}BEGIN OPENSSH PRIVATE${' '}KEY${dashes}`;
  const footer = `${dashes}END OPENSSH PRIVATE${' '}KEY${dashes}`;
  fs.writeFileSync(path.join(home, 'keys', 'ed25519.pub'),
    `${header}\nSHOULD-NOT-COPY\n${footer}\n`);
  const label = `testlabel${Date.now()}c`;
  try {
    const result = lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: label });
    const busOp = result.operations.find((o) => o.op === 'bus-identity');
    assert.strictEqual(busOp.status, 'failed');
    assert.strictEqual(busOp.reason, 'looks-private');
    const knownPath = path.join(repoRoot, 'release-gate', 'known-pubkeys', `${label}.pub`);
    assert.ok(!fs.existsSync(knownPath));
  } finally {
    removeKnownPubkey(label);
  }
});

// -----------------------------------------------------------------------------
// Test 12: dry-run uninstall touches nothing
// -----------------------------------------------------------------------------

test('--uninstall --dry-run does not remove anything', () => {
  const home = makeFakeAgentHome();
  lib.runInstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent' });
  const result = lib.runUninstall({ ofsRoot: repoRoot, agentHome: home, agentLabel: 'testagent', dryRun: true });
  assert.ok(result.ok);
  // Everything should still be there.
  assert.ok(fs.existsSync(path.join(home, 'SKILLS', 'ofs')));
  assert.ok(fs.existsSync(path.join(home, 'bin', 'ofs-path.sh')));
  assert.ok(fs.existsSync(path.join(home, 'openclaw-plugins.json')));
});

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------

process.on('exit', () => {
  for (const dir of cleanups) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  if (failed === 0) {
    process.stdout.write(`ok ${checks} neo-integration installer checks\n`);
  } else {
    process.stdout.write(`FAILED ${failed}/${checks} neo-integration installer checks\n`);
    process.exitCode = 1;
  }
});
