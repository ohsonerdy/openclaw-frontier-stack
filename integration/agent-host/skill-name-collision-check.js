#!/usr/bin/env node
'use strict';

/**
 * integration/agent-host/skill-name-collision-check.js
 *
 * Pre-install check. Walks <agent-home>/SKILLS/ (excluding the bridged
 * OFS subdir) and the OFS skills/ catalog, and reports any name
 * collisions between local agent-native skills and OFS skills.
 *
 * Exits:
 *   0 — no collisions
 *   1 — at least one collision (operator must resolve before install)
 *   2 — bad arguments or missing input
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib/install-lib');

// Default agent home is derived from the running user's home dir; override
// at runtime via --agent-home <path>.
const DEFAULT_AGENT_HOME = path.join(os.homedir(), '.openclaw', 'agents', 'agent-host');

function parseArgs(argv) {
  const opts = { agentHome: null, ofsRoot: null, json: false };
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
      case '--ofs-root':
        opts.ofsRoot = take();
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(
          'Usage: node skill-name-collision-check.js [--agent-home <path>] [--ofs-root <path>] [--json]\n'
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!opts.agentHome) opts.agentHome = DEFAULT_AGENT_HOME;
  if (!opts.ofsRoot) opts.ofsRoot = path.resolve(__dirname, '..', '..');
  return opts;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (err) {
    process.stderr.write(`argument error: ${err.message}\n`);
    process.exit(2);
  }

  if (!fs.existsSync(opts.agentHome)) {
    process.stderr.write(`agent home not found: ${opts.agentHome}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(opts.ofsRoot)) {
    process.stderr.write(`ofs root not found: ${opts.ofsRoot}\n`);
    process.exit(2);
  }

  const { collisions, localSkills, ofsSkills } = lib.findSkillCollisions({
    ofsRoot: opts.ofsRoot,
    agentHome: opts.agentHome,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      agentHome: opts.agentHome,
      ofsRoot: opts.ofsRoot,
      localSkillCount: localSkills.length,
      ofsSkillCount: ofsSkills.length,
      collisions,
      ok: collisions.length === 0,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`collision check: agent=${opts.agentHome}\n`);
    process.stdout.write(`  local skills: ${localSkills.length}\n`);
    process.stdout.write(`  ofs skills:   ${ofsSkills.length}\n`);
    if (collisions.length === 0) {
      process.stdout.write('  collisions:   none\n');
    } else {
      process.stdout.write(`  collisions:   ${collisions.length}\n`);
      for (const name of collisions) process.stdout.write(`    - ${name}\n`);
      process.stdout.write('\n');
      process.stdout.write('resolution: rename one side or remove the conflicting local skill before running the installer.\n');
    }
  }

  process.exit(collisions.length === 0 ? 0 : 1);
}

if (require.main === module) main(process.argv);

module.exports = { parseArgs, main };
