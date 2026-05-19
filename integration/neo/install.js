#!/usr/bin/env node
'use strict';

/**
 * integration/neo/install.js
 *
 * Idempotent installer that wires the OpenClaw Frontier Stack (OFS) into
 * a mesh-agent home dir. Default target is Neo; the same installer drives
 * Yoru and Rei via `--agent-home` / `--yoru-home` / `--rei-home` flags.
 *
 * Usage:
 *   node integration/neo/install.js
 *     [--neo-home <path>] [--yoru-home <path>] [--rei-home <path>]
 *     [--agent-home <path>] [--agent-label <label>]
 *     [--ofs-root <path>]
 *     [--dry-run] [--uninstall]
 *     [--json]
 *
 * Behavior:
 *   - With no flags, installs OFS into the default Neo home dir.
 *   - --dry-run prints planned operations without touching disk.
 *   - --uninstall reverses every step (symlinks, shims, manifest entry,
 *     bus-pubkey registration) and exits 0 even if some steps had nothing
 *     to remove.
 *   - Idempotent: re-running yields zero new operations.
 *
 * Exit codes:
 *   0 — all operations applied (or nothing to do).
 *   1 — fatal precondition failure (missing dir, collision, etc.).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const lib = require('./lib/install-lib');

// The default Neo home is computed from the running user's home dir so the
// installer is portable and so this source file contains no operator-specific
// absolute paths. Override at runtime with --neo-home <path>.
const DEFAULT_NEO_HOME = path.join(os.homedir(), '.openclaw', 'agents', 'neo');

function parseArgs(argv) {
  const opts = {
    agentHome: null,
    agentLabel: null,
    ofsRoot: null,
    dryRun: false,
    uninstall: false,
    json: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const take = () => {
      i += 1;
      if (i >= args.length) throw new Error(`missing value for ${a}`);
      return args[i];
    };
    switch (a) {
      case '--neo-home':
        opts.agentHome = take();
        if (!opts.agentLabel) opts.agentLabel = 'neo';
        break;
      case '--yoru-home':
        opts.agentHome = take();
        opts.agentLabel = 'yoru';
        break;
      case '--rei-home':
        opts.agentHome = take();
        opts.agentLabel = 'rei';
        break;
      case '--agent-home':
        opts.agentHome = take();
        break;
      case '--agent-label':
        opts.agentLabel = take();
        break;
      case '--ofs-root':
        opts.ofsRoot = take();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--uninstall':
        opts.uninstall = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }

  if (!opts.agentHome) opts.agentHome = DEFAULT_NEO_HOME;
  if (!opts.agentLabel) opts.agentLabel = 'neo';
  if (!opts.ofsRoot) opts.ofsRoot = path.resolve(__dirname, '..', '..');
  return opts;
}

function printHelp() {
  process.stdout.write([
    'integration/neo/install.js — wire OFS into a mesh-agent home dir',
    '',
    'Flags:',
    '  --neo-home <path>     Target Neo home (default: <user-home>/.openclaw/agents/neo)',
    '  --yoru-home <path>    Target Yoru home; sets label to "yoru"',
    '  --rei-home <path>     Target Rei home; sets label to "rei"',
    '  --agent-home <path>   Generic agent home',
    '  --agent-label <name>  Label used for bus-pubkey registration (default "neo")',
    '  --ofs-root <path>     OFS package root (default: this package)',
    '  --dry-run             Show planned operations without applying',
    '  --uninstall           Remove OFS wiring from the agent home',
    '  --json                Emit machine-readable JSON instead of human prose',
    '',
  ].join('\n'));
}

function summarize(result) {
  const byStatus = new Map();
  for (const op of result.operations) {
    byStatus.set(op.status, (byStatus.get(op.status) || 0) + 1);
  }
  return Object.fromEntries(byStatus);
}

function renderHuman(opts, result) {
  const mode = opts.uninstall ? 'uninstall' : 'install';
  const dry = result.dryRun ? ' [dry-run]' : '';
  const lines = [];
  lines.push(`ofs ${mode}${dry} agent=${opts.agentLabel} home=${opts.agentHome}`);
  lines.push(`ofs root: ${opts.ofsRoot}`);
  const summary = summarize(result);
  lines.push(`summary: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ') || 'no-ops'}`);
  // Per-op detail (compact)
  for (const op of result.operations) {
    const extra = op.reason ? ` reason=${op.reason}` : '';
    lines.push(`  ${op.op} ${op.target} -> ${op.status}${extra}`);
  }
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  lines.push(`ok: ${result.ok}`);
  return lines.join('\n');
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (err) {
    process.stderr.write(`argument error: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }

  // Defensive: refuse to operate on a path that looks like a private-key dir.
  if (/keys[\\/](ed25519|ssh|private)/i.test(opts.agentHome)) {
    process.stderr.write(`refusing to use agent-home that looks like a key dir: ${opts.agentHome}\n`);
    process.exit(2);
  }

  const action = opts.uninstall ? lib.runUninstall : lib.runInstall;
  const result = action({
    ofsRoot: opts.ofsRoot,
    agentHome: opts.agentHome,
    agentLabel: opts.agentLabel,
    dryRun: opts.dryRun,
    logger: (msg) => process.stderr.write(`${msg}\n`),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      mode: opts.uninstall ? 'uninstall' : 'install',
      dryRun: result.dryRun,
      agentLabel: opts.agentLabel,
      agentHome: opts.agentHome,
      ofsRoot: opts.ofsRoot,
      ok: result.ok,
      summary: summarize(result),
      operations: result.operations,
      warnings: result.warnings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(opts, result) + '\n');
  }

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main(process.argv);

module.exports = { parseArgs, main };
