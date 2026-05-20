#!/usr/bin/env node
'use strict';

/**
 * integration/agent-host/install.js
 *
 * Idempotent installer that wires the OpenClaw Frontier Stack (OFS) into
 * an agent-host home dir. The operator declares the target via
 * `--agent-home <path>` and a `--agent-label <name>` for bus-pubkey
 * registration. The same installer drives any number of distinct agent
 * hosts — invoke it once per host.
 *
 * Usage:
 *   node integration/agent-host/install.js
 *     --agent-home <path> [--agent-label <label>]
 *     [--ofs-root <path>]
 *     [--dry-run] [--uninstall]
 *     [--json]
 *
 * Behavior:
 *   - With no flags, installs OFS into the default agent home dir
 *     (<user-home>/.openclaw/agents/<label>).
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

// The default agent home is computed from the running user's home dir so the
// installer is portable and so this source file contains no operator-specific
// absolute paths. Override at runtime with --agent-home <path>.
const DEFAULT_AGENT_LABEL = 'agent-host';
const defaultAgentHome = (label) => path.join(os.homedir(), '.openclaw', 'agents', label || DEFAULT_AGENT_LABEL);

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

  if (!opts.agentLabel) opts.agentLabel = DEFAULT_AGENT_LABEL;
  if (!opts.agentHome) opts.agentHome = defaultAgentHome(opts.agentLabel);
  if (!opts.ofsRoot) opts.ofsRoot = path.resolve(__dirname, '..', '..');
  return opts;
}

function printHelp() {
  process.stdout.write([
    'integration/agent-host/install.js — wire OFS into an agent-host home dir',
    '',
    'Flags:',
    '  --agent-home <path>   Target agent-host home (default: <user-home>/.openclaw/agents/<label>)',
    '  --agent-label <name>  Label used for bus-pubkey registration (default "agent-host")',
    '  --ofs-root <path>     OFS package root (default: this package)',
    '  --dry-run             Show planned operations without applying',
    '  --uninstall           Remove OFS wiring from the agent home',
    '  --json                Emit machine-readable JSON instead of human prose',
    '',
    'For multi-host setups, invoke once per host with distinct --agent-home',
    'and --agent-label values.',
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
