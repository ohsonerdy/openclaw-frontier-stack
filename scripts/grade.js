#!/usr/bin/env node
'use strict';

/**
 * scripts/grade.js — operator-facing grading CLI.
 *
 * Usage:
 *   node scripts/grade.js [--version <v>] [--out <path>]
 *                         [--skip-mutation] [--tier-3]
 *                         [--mutations <id1,id2,...>]
 *                         [--quiet] [--json]
 *
 * Writes:
 *   release-gate/reports/grade-<version>.json   (the structured Grade record)
 *   release-gate/scorecards/grade-<version>.md  (the operator scorecard)
 *
 * Exit code: 0 if composite >= 60 AND public-safety did not fire. Else 1.
 */

const fs = require('fs');
const path = require('path');

const { runGrade } = require('../lib/grading/grade.js');
const { renderScorecard } = require('../lib/grading/scorecard.js');

function parseArgs(argv) {
  const out = {
    version: null,
    out: null,
    skipMutation: false,
    tier3: false,
    mutations: null,
    quiet: false,
    json: false,
    goalLoopIterations: 10,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--version': out.version = next; i += 1; break;
      case '--out': out.out = next; i += 1; break;
      case '--skip-mutation': out.skipMutation = true; break;
      case '--tier-3': out.tier3 = true; break;
      case '--mutations': out.mutations = String(next || '').split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--iterations': out.goalLoopIterations = Math.max(1, Number.parseInt(next, 10) || 10); i += 1; break;
      case '--quiet': out.quiet = true; break;
      case '--json': out.json = true; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith('--')) {
          process.stderr.write(`unknown flag: ${arg}\n`);
          process.exit(2);
        }
    }
  }
  return out;
}

function printUsage() {
  process.stdout.write([
    'Usage: node scripts/grade.js [options]',
    '',
    'Options:',
    '  --version <v>           override the version label (default package.json#version)',
    '  --out <path>            override the report path stem',
    '  --skip-mutation         skip tier-4 mutation testing (faster iteration)',
    '  --tier-3                enable tier-3 live skill eval categories',
    '  --mutations <ids>       comma-separated mutation ids to include',
    '  --iterations <n>        goal-loop iteration count (default 10)',
    '  --quiet                 suppress per-category progress on stderr',
    '  --json                  emit only JSON on stdout',
    '  --help                  show this message',
    '',
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = args.version || pkg.version;
  const reportsDir = path.join(root, 'release-gate', 'reports');
  const scorecardsDir = path.join(root, 'release-gate', 'scorecards');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(scorecardsDir, { recursive: true });

  const jsonOutPath = args.out
    ? path.resolve(args.out)
    : path.join(reportsDir, `grade-${version}.json`);
  const mdOutPath = args.out
    ? path.resolve(args.out).replace(/\.json$/, '.md')
    : path.join(scorecardsDir, `grade-${version}.md`);

  const onProgress = args.quiet
    ? null
    : (p) => {
        if (p.stage === 'mutation-progress') {
          process.stderr.write(`  [mutation ${p.index}/${p.total}] ${p.id}: ${p.caught ? 'CAUGHT' : 'ESCAPED'} (${p.durationMs}ms)\n`);
        } else if (p.stage === 'category-start') {
          process.stderr.write(`[category] start: ${p.id}\n`);
        } else if (p.stage === 'category-done') {
          process.stderr.write(`[category] done:  ${p.id} -> ${p.score}\n`);
        } else if (p.stage === 'done') {
          process.stderr.write(`[composite] ${p.composite.score} (${p.composite.letter})${p.composite.capped ? ' capped' : ''}\n`);
        }
      };

  const grade = await runGrade({
    root,
    version,
    skipMutation: args.skipMutation,
    tier3: args.tier3,
    mutations: args.mutations,
    goalLoopIterations: args.goalLoopIterations,
    onProgress,
  });

  fs.writeFileSync(jsonOutPath, JSON.stringify(grade, null, 2) + '\n');
  const md = renderScorecard(grade);
  fs.writeFileSync(mdOutPath, md);

  const summary = {
    ok: grade.composite.score >= 60 && grade.composite.score >= 0 && !(grade.categories.find((c) => c.id === 'public-safety') || {}).score === 0,
    version: grade.version,
    composite: grade.composite,
    reportPath: path.relative(root, jsonOutPath),
    scorecardPath: path.relative(root, mdOutPath),
    perCategory: grade.categories.map((c) => ({ id: c.id, score: c.score })),
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  }
  // Exit non-zero if composite below 60 OR public-safety gate fired.
  const safetyRow = grade.categories.find((c) => c.id === 'public-safety');
  const safetyFailed = safetyRow && safetyRow.score === 0;
  const compositeBelow = typeof grade.composite.score !== 'number' || grade.composite.score < 60;
  process.exit(safetyFailed || compositeBelow ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`scripts/grade.js failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
