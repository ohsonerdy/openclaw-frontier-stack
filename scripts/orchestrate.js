#!/usr/bin/env node
'use strict';

/**
 * orchestrate.js — the OpenClaw Frontier Stack orchestration harness.
 *
 * Reads a `/goal` JSON document from stdin or `--goal-file <path>`, dispatches
 * one task-claim per lane to the blackboard ledger, polls for result records,
 * and emits a synthesis trace as JSON on stdout. Exits non-zero when any lane
 * is not GREEN.
 *
 * Usage:
 *
 *   node scripts/orchestrate.js --goal-file path/to/goal.json
 *   cat goal.json | node scripts/orchestrate.js
 *   node scripts/orchestrate.js --goal-file goal.json --mock-agents
 *   node scripts/orchestrate.js --goal-file goal.json --dry-run
 *
 * Flags:
 *
 *   --goal-file <path>     Read goal record from this JSON file (default stdin)
 *   --blackboard <path>    Path to the blackboard ledger jsonl
 *                          (default: ./blackboard.jsonl)
 *   --max-wait-ms <ms>     How long to wait for live agents (default 300000)
 *   --mock-agents          Synthesize lane results in-process so the loop
 *                          closes without a live bus / agents. Use for tests.
 *   --dry-run              Do not write to the ledger; emit a simulated trace.
 *   --help                 Show this help and exit
 *
 * The harness does NOT execute agent prompts. "Dispatch" is a `task-claim`
 * record written to the blackboard ledger; the live agent is expected to
 * observe the ledger via the signed bus or polling and respond with a
 * `result` record. In `--mock-agents` mode the harness plays every role for
 * verification and demos.
 */

const fs = require('fs');
const path = require('path');

const { runGoalLoop, GoalValidationError } = require('../src/orchestrator/lib/goal-loop.js');

function help() {
  process.stdout.write(`orchestrate.js — OpenClaw Frontier Stack orchestration harness

Usage:
  node scripts/orchestrate.js --goal-file <path>
  cat goal.json | node scripts/orchestrate.js

Flags:
  --goal-file <path>     Read goal record from this JSON file (default stdin)
  --blackboard <path>    Path to the blackboard ledger jsonl
                         (default: ./blackboard.jsonl)
  --max-wait-ms <ms>     How long to wait for live agents (default 300000)
  --mock-agents          Synthesize lane results in-process so the loop
                         closes without a live bus / agents
  --dry-run              Do not write to the ledger; emit a simulated trace
  --help                 Show this help and exit

Exit codes:
  0  All lanes returned GREEN
  1  At least one lane failed or timed out
  2  Bad CLI arguments or goal validation error
`);
}

function parseArgs(argv) {
  const args = {
    goalFile: null,
    blackboard: path.resolve(process.cwd(), 'blackboard.jsonl'),
    maxWaitMs: 300000,
    mockAgents: false,
    dryRun: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--goal-file') args.goalFile = argv[++i];
    else if (a === '--blackboard') args.blackboard = path.resolve(process.cwd(), argv[++i]);
    else if (a === '--max-wait-ms') args.maxWaitMs = Number(argv[++i]);
    else if (a === '--mock-agents') args.mockAgents = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

function loadGoal(args) {
  if (args.goalFile) {
    const resolved = path.resolve(process.cwd(), args.goalFile);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`goal file not found: ${resolved}\n`);
      process.exit(2);
    }
    const text = fs.readFileSync(resolved, 'utf8');
    try {
      return JSON.parse(text);
    } catch (err) {
      process.stderr.write(`goal file is not valid JSON: ${err.message}\n`);
      process.exit(2);
    }
  }
  const stdin = readStdinSync();
  if (!stdin.trim()) {
    process.stderr.write('no goal provided. Use --goal-file <path> or pipe a goal JSON document on stdin. --help for usage.\n');
    process.exit(2);
  }
  try {
    return JSON.parse(stdin);
  } catch (err) {
    process.stderr.write(`stdin is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); return; }
  const goal = loadGoal(args);
  let trace;
  try {
    trace = await runGoalLoop({
      goal,
      blackboardPath: args.blackboard,
      maxWaitMs: args.maxWaitMs,
      mockAgents: args.mockAgents,
      dryRun: args.dryRun,
    });
  } catch (err) {
    if (err instanceof GoalValidationError) {
      process.stderr.write(`goal validation failed: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`orchestrate.js: ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(trace, null, 2) + '\n');
  if (args.dryRun) return;
  process.exit(trace.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`orchestrate.js: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
