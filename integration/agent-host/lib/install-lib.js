'use strict';

/**
 * integration/agent-host/lib/install-lib.js
 *
 * Pure operations for wiring the OpenClaw Frontier Stack (OFS) into an
 * agent-host home dir. The same functions drive every host install by
 * passing different `agentHome` paths and `agentLabel` values.
 *
 * Design rules:
 *   - Idempotent: repeated runs of any operation yield the same final state.
 *   - No git, no network, no env mutation. Pure filesystem + structured logs.
 *   - Windows-safe: directory symlinks use `type: 'junction'` to avoid the
 *     "developer mode / SeCreateSymbolicLinkPrivilege" requirement. If even
 *     a junction cannot be created (filesystem refusal, cross-volume, etc.)
 *     we fall back to a recursive file-copy and log the reason.
 *   - The bus-registration step copies a pubkey only — it never reads or
 *     generates a private key.
 *   - No emoji output, no PII, no operator-internal hostnames in logs.
 *
 * Returned shape from `runInstall` / `runUninstall`:
 *   {
 *     ok: boolean,
 *     dryRun: boolean,
 *     operations: Array<{ op, target, status, reason? }>,
 *     warnings: string[],
 *   }
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFS_PLUGIN_ID = 'openclaw-frontier-stack';
const OFS_SKILLS_SUBDIR = 'ofs'; // <agent-home>/SKILLS/ofs/<skill>
const PLUGIN_MANIFEST_NAME = 'openclaw-plugins.json';
const PATH_SHIM_BASH = 'ofs-path.sh';
const PATH_SHIM_PS = 'ofs-path.ps1';
const KEY_FILENAME = 'ed25519.pub';
const KNOWN_PUBKEYS_DIR = path.join('release-gate', 'known-pubkeys');
const PUBKEY_FILE_FORMAT = /^[A-Za-z0-9_\-]+$/;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pathExists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function isSymlinkOrJunction(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function readSymlinkTarget(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

function listDirEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function listSkillDirs(skillsRoot) {
  const out = [];
  for (const entry of listDirEntries(skillsRoot)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const skillMd = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (fs.existsSync(skillMd)) out.push(entry.name);
  }
  out.sort();
  return out;
}

function copyDirRecursive(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function removeRecursive(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function readJsonIfPresent(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Skill bridge — symlink (or fallback copy) per individual skill
// ---------------------------------------------------------------------------

/**
 * Create one bridge entry per OFS skill at
 * <agent-home>/SKILLS/ofs/<skill-name>. Prefer a junction (works without
 * admin elevation on Windows). If junction creation fails, fall back to a
 * recursive file-copy and record the reason.
 */
function bridgeSkills({ ofsRoot, agentHome, dryRun, logger }) {
  const ops = [];
  const warnings = [];

  const srcRoot = path.join(ofsRoot, 'skills');
  const dstRoot = path.join(agentHome, 'SKILLS', OFS_SKILLS_SUBDIR);

  if (!fs.existsSync(srcRoot)) {
    warnings.push(`ofs skills dir missing: ${srcRoot}`);
    return { ops, warnings };
  }

  if (!dryRun) ensureDir(dstRoot);

  const skills = listSkillDirs(srcRoot);
  for (const name of skills) {
    const src = path.join(srcRoot, name);
    const dst = path.join(dstRoot, name);

    if (pathExists(dst)) {
      // Already linked? If it is a symlink pointing at our source, treat as no-op.
      if (isSymlinkOrJunction(dst)) {
        const tgt = readSymlinkTarget(dst);
        if (tgt && path.resolve(path.dirname(dst), tgt) === path.resolve(src)) {
          ops.push({ op: 'skill-bridge', target: name, status: 'already-linked' });
          continue;
        }
      }
      // Else assume it is a copy we previously placed — leave it but flag.
      ops.push({ op: 'skill-bridge', target: name, status: 'already-present' });
      continue;
    }

    if (dryRun) {
      ops.push({ op: 'skill-bridge', target: name, status: 'would-link' });
      continue;
    }

    let placed = false;
    let mode = null;
    let reason = null;
    try {
      fs.symlinkSync(src, dst, 'junction');
      placed = true;
      mode = 'junction';
    } catch (errJunction) {
      try {
        // Some POSIX hosts don't accept the 'junction' type — try plain dir symlink.
        fs.symlinkSync(src, dst, 'dir');
        placed = true;
        mode = 'symlink-dir';
      } catch (errSym) {
        reason = `junction=${errJunction.code || errJunction.message}; symlink=${errSym.code || errSym.message}`;
        try {
          copyDirRecursive(src, dst);
          placed = true;
          mode = 'copy-fallback';
        } catch (errCopy) {
          reason = `${reason}; copy=${errCopy.code || errCopy.message}`;
        }
      }
    }

    if (placed) {
      const status = mode === 'copy-fallback' ? 'copied-fallback' : 'linked';
      const op = { op: 'skill-bridge', target: name, status, mode };
      if (reason) op.reason = reason;
      ops.push(op);
      if (mode === 'copy-fallback' && logger) logger(`skill-bridge copy fallback for ${name}: ${reason}`);
    } else {
      ops.push({ op: 'skill-bridge', target: name, status: 'failed', reason });
      warnings.push(`skill-bridge failed for ${name}: ${reason}`);
    }
  }

  return { ops, warnings };
}

// ---------------------------------------------------------------------------
// Bin bridge — generated PATH-shim scripts
// ---------------------------------------------------------------------------

function bashShimContent(ofsRoot) {
  const ofsBin = path.join(ofsRoot, 'bin').replace(/\\/g, '/');
  return [
    '#!/usr/bin/env bash',
    '# Generated by integration/agent-host/install.js. Do not edit by hand.',
    `# Source this from your session-start hook: source "${PATH_SHIM_BASH}"`,
    `export OPENCLAW_OFS_ROOT="${ofsRoot.replace(/\\/g, '/')}"`,
    `case ":$PATH:" in`,
    `  *":${ofsBin}:"*) ;;`,
    `  *) export PATH="${ofsBin}:$PATH" ;;`,
    'esac',
    '',
  ].join('\n');
}

function ps1ShimContent(ofsRoot) {
  const ofsBin = path.join(ofsRoot, 'bin');
  return [
    '# Generated by integration/agent-host/install.js. Do not edit by hand.',
    '# Dot-source this from your session-start hook: . .\\ofs-path.ps1',
    `$env:OPENCLAW_OFS_ROOT = '${ofsRoot.replace(/'/g, "''")}'`,
    `$ofsBin = '${ofsBin.replace(/'/g, "''")}'`,
    'if (-not ($env:PATH -split [IO.Path]::PathSeparator | Where-Object { $_ -eq $ofsBin })) {',
    '  $env:PATH = $ofsBin + [IO.Path]::PathSeparator + $env:PATH',
    '}',
    '',
  ].join('\n');
}

function bridgeBinPath({ ofsRoot, agentHome, dryRun }) {
  const ops = [];
  const warnings = [];

  const binDir = path.join(agentHome, 'bin');
  if (!dryRun) ensureDir(binDir);

  const shimBash = path.join(binDir, PATH_SHIM_BASH);
  const shimPs1 = path.join(binDir, PATH_SHIM_PS);

  const newBash = bashShimContent(ofsRoot);
  const newPs1 = ps1ShimContent(ofsRoot);

  for (const [p, content, label] of [
    [shimBash, newBash, 'shim-bash'],
    [shimPs1, newPs1, 'shim-ps1'],
  ]) {
    const existing = pathExists(p) ? fs.readFileSync(p, 'utf8') : null;
    if (existing === content) {
      ops.push({ op: 'path-shim', target: label, status: 'already-current' });
      continue;
    }
    if (dryRun) {
      ops.push({ op: 'path-shim', target: label, status: existing == null ? 'would-create' : 'would-update' });
      continue;
    }
    fs.writeFileSync(p, content);
    ops.push({ op: 'path-shim', target: label, status: existing == null ? 'created' : 'updated' });
  }

  return { ops, warnings };
}

// ---------------------------------------------------------------------------
// Plugin manifest — durable record the agent-host's session-init reads at startup
// ---------------------------------------------------------------------------

function readOfsPackageVersion(ofsRoot) {
  const pkgPath = path.join(ofsRoot, 'package.json');
  const pkg = readJsonIfPresent(pkgPath);
  if (!pkg || typeof pkg.version !== 'string') {
    throw new Error(`cannot read version from ${pkgPath}`);
  }
  return pkg.version;
}

function writePluginManifest({ ofsRoot, agentHome, dryRun }) {
  const ops = [];
  const warnings = [];

  const manifestPath = path.join(agentHome, PLUGIN_MANIFEST_NAME);
  const version = readOfsPackageVersion(ofsRoot);

  const desired = {
    schema: 'openclaw-agent.plugin-manifest.v1',
    plugins: [{
      id: OFS_PLUGIN_ID,
      version,
      skillsPath: path.join(ofsRoot, 'skills'),
      binPath: path.join(ofsRoot, 'bin'),
    }],
  };

  const current = readJsonIfPresent(manifestPath);
  // Merge: preserve any non-OFS plugins the agent has from other installers.
  let merged = desired;
  if (current && Array.isArray(current.plugins)) {
    const others = current.plugins.filter((pl) => pl && pl.id !== OFS_PLUGIN_ID);
    merged = {
      schema: 'openclaw-agent.plugin-manifest.v1',
      plugins: [...others, desired.plugins[0]],
    };
  }

  const same = current && JSON.stringify(current) === JSON.stringify(merged);
  if (same) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'already-current' });
    return { ops, warnings };
  }
  if (dryRun) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: current == null ? 'would-create' : 'would-update' });
    return { ops, warnings };
  }
  writeJsonAtomic(manifestPath, merged);
  ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: current == null ? 'created' : 'updated' });
  return { ops, warnings };
}

// ---------------------------------------------------------------------------
// Bus identity — register the agent's Ed25519 pubkey with OFS
// ---------------------------------------------------------------------------

function registerBusPubkey({ ofsRoot, agentHome, agentLabel, dryRun }) {
  const ops = [];
  const warnings = [];

  const srcKey = path.join(agentHome, 'keys', KEY_FILENAME);
  if (!fs.existsSync(srcKey)) {
    warnings.push(`bus-identity: ${srcKey} not found; skipping signed-bus registration`);
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'skipped', reason: 'no-pubkey' });
    return { ops, warnings };
  }

  if (!PUBKEY_FILE_FORMAT.test(agentLabel)) {
    warnings.push(`bus-identity: refusing to register pubkey under suspicious label ${JSON.stringify(agentLabel)}`);
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'failed', reason: 'bad-label' });
    return { ops, warnings };
  }

  const dstDir = path.join(ofsRoot, KNOWN_PUBKEYS_DIR);
  const dstKey = path.join(dstDir, `${agentLabel}.pub`);

  let srcBuf;
  try { srcBuf = fs.readFileSync(srcKey); }
  catch (err) {
    warnings.push(`bus-identity: cannot read ${srcKey}: ${err.code || err.message}`);
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'failed', reason: 'unreadable-pubkey' });
    return { ops, warnings };
  }
  // Sanity-check: refuse to register anything that looks like a private key.
  const head = srcBuf.toString('utf8', 0, Math.min(srcBuf.length, 256)).toLowerCase();
  if (head.includes('private') || head.includes('begin ed25519 private')) {
    warnings.push('bus-identity: source file appears to be a private key; refusing to register');
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'failed', reason: 'looks-private' });
    return { ops, warnings };
  }

  if (fs.existsSync(dstKey)) {
    const existing = fs.readFileSync(dstKey);
    if (Buffer.compare(existing, srcBuf) === 0) {
      ops.push({ op: 'bus-identity', target: agentLabel, status: 'already-registered' });
      return { ops, warnings };
    }
    if (dryRun) {
      ops.push({ op: 'bus-identity', target: agentLabel, status: 'would-update' });
      return { ops, warnings };
    }
    ensureDir(dstDir);
    fs.writeFileSync(dstKey, srcBuf);
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'updated' });
    return { ops, warnings };
  }

  if (dryRun) {
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'would-register' });
    return { ops, warnings };
  }
  ensureDir(dstDir);
  fs.writeFileSync(dstKey, srcBuf);
  ops.push({ op: 'bus-identity', target: agentLabel, status: 'registered' });
  return { ops, warnings };
}

// ---------------------------------------------------------------------------
// Skill name collision check — fail-closed if a local skill conflicts
// ---------------------------------------------------------------------------

function findSkillCollisions({ ofsRoot, agentHome }) {
  const agentSkillsRoot = path.join(agentHome, 'SKILLS');
  const ofsSkillsRoot = path.join(ofsRoot, 'skills');

  const localSkills = listSkillDirs(agentSkillsRoot);
  const ofsSkills = listSkillDirs(ofsSkillsRoot);
  const localSet = new Set(localSkills);
  const collisions = ofsSkills.filter((n) => localSet.has(n));
  return { collisions, localSkills, ofsSkills };
}

// ---------------------------------------------------------------------------
// Install orchestration
// ---------------------------------------------------------------------------

function runInstall(opts) {
  const ofsRoot = path.resolve(opts.ofsRoot);
  const agentHome = path.resolve(opts.agentHome);
  const dryRun = Boolean(opts.dryRun);
  const agentLabel = opts.agentLabel || 'agent-host';
  const logger = opts.logger || (() => {});

  const result = { ok: true, dryRun, operations: [], warnings: [] };

  if (!fs.existsSync(agentHome)) {
    result.ok = false;
    result.warnings.push(`agent home not found: ${agentHome}`);
    return result;
  }
  if (!fs.existsSync(ofsRoot)) {
    result.ok = false;
    result.warnings.push(`ofs root not found: ${ofsRoot}`);
    return result;
  }

  // Pre-flight: skill name collisions.
  const { collisions } = findSkillCollisions({ ofsRoot, agentHome });
  if (collisions.length > 0) {
    result.ok = false;
    result.warnings.push(
      `skill name collisions between agent local skills and OFS skills: ${collisions.join(', ')}. ` +
      'Refusing to install — rename one side or remove the conflicting local skill before retrying.'
    );
    return result;
  }

  for (const step of [bridgeSkills, bridgeBinPath, writePluginManifest]) {
    const out = step({ ofsRoot, agentHome, dryRun, logger });
    result.operations.push(...out.ops);
    result.warnings.push(...out.warnings);
  }

  const bus = registerBusPubkey({ ofsRoot, agentHome, agentLabel, dryRun });
  result.operations.push(...bus.ops);
  result.warnings.push(...bus.warnings);

  return result;
}

// ---------------------------------------------------------------------------
// Uninstall orchestration — reverses every operation runInstall does
// ---------------------------------------------------------------------------

function uninstallSkills({ agentHome, dryRun }) {
  const ops = [];
  const warnings = [];

  const dstRoot = path.join(agentHome, 'SKILLS', OFS_SKILLS_SUBDIR);
  if (!fs.existsSync(dstRoot)) {
    ops.push({ op: 'skill-bridge', target: OFS_SKILLS_SUBDIR, status: 'nothing-to-remove' });
    return { ops, warnings };
  }

  if (dryRun) {
    ops.push({ op: 'skill-bridge', target: OFS_SKILLS_SUBDIR, status: 'would-remove' });
    return { ops, warnings };
  }

  // Remove each entry under SKILLS/ofs/ — entries are typically junctions/symlinks,
  // but copy-fallbacks are real dirs. fs.rmSync with recursive handles both.
  for (const entry of listDirEntries(dstRoot)) {
    const p = path.join(dstRoot, entry.name);
    try { removeRecursive(p); }
    catch (err) { warnings.push(`failed to remove ${p}: ${err.code || err.message}`); }
  }
  try { fs.rmdirSync(dstRoot); }
  catch (err) { warnings.push(`failed to rmdir ${dstRoot}: ${err.code || err.message}`); }
  ops.push({ op: 'skill-bridge', target: OFS_SKILLS_SUBDIR, status: 'removed' });
  return { ops, warnings };
}

function uninstallBinShims({ agentHome, dryRun }) {
  const ops = [];
  const warnings = [];

  const binDir = path.join(agentHome, 'bin');
  for (const name of [PATH_SHIM_BASH, PATH_SHIM_PS]) {
    const p = path.join(binDir, name);
    if (!fs.existsSync(p)) {
      ops.push({ op: 'path-shim', target: name, status: 'nothing-to-remove' });
      continue;
    }
    if (dryRun) {
      ops.push({ op: 'path-shim', target: name, status: 'would-remove' });
      continue;
    }
    try { fs.unlinkSync(p); ops.push({ op: 'path-shim', target: name, status: 'removed' }); }
    catch (err) { warnings.push(`failed to remove ${p}: ${err.code || err.message}`); }
  }
  return { ops, warnings };
}

function uninstallPluginManifest({ agentHome, dryRun }) {
  const ops = [];
  const warnings = [];
  const manifestPath = path.join(agentHome, PLUGIN_MANIFEST_NAME);
  const current = readJsonIfPresent(manifestPath);
  if (!current) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'nothing-to-remove' });
    return { ops, warnings };
  }
  if (!Array.isArray(current.plugins)) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'malformed-no-op' });
    return { ops, warnings };
  }
  const remaining = current.plugins.filter((pl) => pl && pl.id !== OFS_PLUGIN_ID);
  if (remaining.length === current.plugins.length) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'nothing-to-remove' });
    return { ops, warnings };
  }
  if (dryRun) {
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'would-update' });
    return { ops, warnings };
  }
  if (remaining.length === 0) {
    fs.unlinkSync(manifestPath);
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'removed' });
  } else {
    writeJsonAtomic(manifestPath, { schema: 'openclaw-agent.plugin-manifest.v1', plugins: remaining });
    ops.push({ op: 'plugin-manifest', target: PLUGIN_MANIFEST_NAME, status: 'updated' });
  }
  return { ops, warnings };
}

function uninstallBusIdentity({ ofsRoot, agentLabel, dryRun }) {
  const ops = [];
  const warnings = [];
  if (!PUBKEY_FILE_FORMAT.test(agentLabel)) {
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'bad-label-skipped' });
    return { ops, warnings };
  }
  const dstKey = path.join(ofsRoot, KNOWN_PUBKEYS_DIR, `${agentLabel}.pub`);
  if (!fs.existsSync(dstKey)) {
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'nothing-to-remove' });
    return { ops, warnings };
  }
  if (dryRun) {
    ops.push({ op: 'bus-identity', target: agentLabel, status: 'would-unregister' });
    return { ops, warnings };
  }
  try { fs.unlinkSync(dstKey); ops.push({ op: 'bus-identity', target: agentLabel, status: 'unregistered' }); }
  catch (err) { warnings.push(`failed to remove ${dstKey}: ${err.code || err.message}`); }
  return { ops, warnings };
}

function runUninstall(opts) {
  const ofsRoot = path.resolve(opts.ofsRoot);
  const agentHome = path.resolve(opts.agentHome);
  const dryRun = Boolean(opts.dryRun);
  const agentLabel = opts.agentLabel || 'agent-host';

  const result = { ok: true, dryRun, operations: [], warnings: [] };

  if (!fs.existsSync(agentHome)) {
    result.warnings.push(`agent home not found: ${agentHome} (nothing to uninstall)`);
    return result;
  }

  for (const step of [
    uninstallSkills,
    uninstallBinShims,
    uninstallPluginManifest,
  ]) {
    const out = step({ agentHome, dryRun });
    result.operations.push(...out.ops);
    result.warnings.push(...out.warnings);
  }
  const bus = uninstallBusIdentity({ ofsRoot, agentLabel, dryRun });
  result.operations.push(...bus.ops);
  result.warnings.push(...bus.warnings);

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  OFS_PLUGIN_ID,
  OFS_SKILLS_SUBDIR,
  PLUGIN_MANIFEST_NAME,
  PATH_SHIM_BASH,
  PATH_SHIM_PS,
  KEY_FILENAME,
  KNOWN_PUBKEYS_DIR,

  // High-level
  runInstall,
  runUninstall,

  // Individual ops (importable for tests / additional hosts)
  bridgeSkills,
  bridgeBinPath,
  writePluginManifest,
  registerBusPubkey,
  findSkillCollisions,
  uninstallSkills,
  uninstallBinShims,
  uninstallPluginManifest,
  uninstallBusIdentity,

  // Helpers
  listSkillDirs,
  readOfsPackageVersion,
};
