#!/usr/bin/env node
'use strict';

/**
 * run-skill-evals.js — Modern Skills eval runner.
 *
 * Two modes:
 *
 *   1. Dry-run (default, no API call)
 *      Loads every evals.json under skills/, validates structure, prints a
 *      structured plan: how many evals per skill, how many assertions total.
 *      Useful in CI for catching malformed eval files before they reach the
 *      model. Zero external dependencies. Always free.
 *
 *   2. Live mode (--live --model <model-id>)
 *      Same plan, but for each eval also calls the Claude API with the
 *      eval prompt loaded against the SKILL.md as system prompt. Returns
 *      the model output and a per-assertion check (substring/regex match
 *      heuristic). Requires ANTHROPIC_API_KEY in the environment.
 *
 * Usage:
 *
 *   node scripts/run-skill-evals.js                      # dry-run, all skills
 *   node scripts/run-skill-evals.js --skill cro          # dry-run, one skill
 *   node scripts/run-skill-evals.js --live --model claude-sonnet-4-6
 *   node scripts/run-skill-evals.js --live --skill cro --model claude-opus-4-7
 *
 * Output: JSON to stdout. Non-zero exit if any eval file is malformed (dry-run)
 * or if any assertion fails (live mode).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const skillsDir = path.join(root, 'skills');

function parseArgs(argv) {
  const args = { live: false, model: null, skill: null, maxParallel: 4 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--skill') args.skill = argv[++i];
    else if (a === '--max-parallel') args.maxParallel = Number(argv[++i]) || 4;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function help() {
  console.log(`run-skill-evals.js — Modern Skills eval runner

Modes:
  Dry-run (default):  validates eval-file structure, no API calls
  Live (--live):      calls Claude API with each eval, scores assertions

Flags:
  --live                 Enable live mode (requires ANTHROPIC_API_KEY)
  --model <model-id>     Claude model id (live mode only)
                         Examples: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
  --skill <skill-name>   Run only this skill (default: all)
  --max-parallel <n>     Max concurrent live calls (default 4, ignored in dry-run)
  --help                 Show this help

Exit codes:
  0  All evals passed (live) or all eval files valid (dry-run)
  1  Any eval failed (live) or any eval file malformed (dry-run)
  2  Bad CLI arguments
`);
}

function listSkillDirs(filter) {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !filter || n === filter)
    .sort();
}

function readEvalsFile(skillName) {
  const evalsPath = path.join(skillsDir, skillName, 'evals', 'evals.json');
  if (!fs.existsSync(evalsPath)) return null;
  const raw = fs.readFileSync(evalsPath, 'utf8');
  return JSON.parse(raw);
}

function readSkillContent(skillName) {
  const p = path.join(skillsDir, skillName, 'SKILL.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function validateEvalsFile(skillName, evalsObj) {
  const errors = [];
  if (!evalsObj || typeof evalsObj !== 'object') {
    return ['evals.json is not an object'];
  }
  if (evalsObj.skill_name !== skillName) {
    errors.push(`skill_name mismatch: ${evalsObj.skill_name} !== ${skillName}`);
  }
  if (!Array.isArray(evalsObj.evals)) {
    errors.push('evals field must be an array');
    return errors;
  }
  if (evalsObj.evals.length < 1) errors.push('evals array is empty');
  evalsObj.evals.forEach((e, i) => {
    if (typeof e.id !== 'number' && typeof e.id !== 'string') errors.push(`eval[${i}].id missing or wrong type`);
    if (typeof e.prompt !== 'string' || !e.prompt.trim()) errors.push(`eval[${i}].prompt missing or empty`);
    if (typeof e.expected_output !== 'string' || !e.expected_output.trim()) errors.push(`eval[${i}].expected_output missing or empty`);
    if (!Array.isArray(e.assertions) || e.assertions.length === 0) errors.push(`eval[${i}].assertions missing or empty`);
  });
  return errors;
}

async function callClaude({ model, system, userPrompt, apiKey }) {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'Anthropic-Version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(text);
          if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${parsed.error?.message || text}`));
          const output = (parsed.content || []).map((b) => b.text || '').join('\n').trim();
          resolve({ output, usage: parsed.usage || null });
        } catch (err) {
          reject(new Error(`Bad response (${res.statusCode}): ${text.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function scoreAssertion(output, assertion) {
  // Heuristic: case-insensitive substring search across the assertion's key
  // phrases. The assertion is a human-readable string like "Calls
  // modern.X.Y via modern-mcp if connected" — we extract identifier-shaped
  // tokens and look for them.
  const tokens = (assertion.match(/(?:modern\.[a-z_.]+|[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*|[a-z_-]{4,})/g) || [])
    .map((t) => t.toLowerCase())
    .filter((t, i, a) => a.indexOf(t) === i);
  const lowOut = output.toLowerCase();
  const hits = tokens.filter((t) => lowOut.includes(t));
  // Soft pass: 50%+ of distinctive tokens appear in the output
  const pass = tokens.length === 0 ? false : hits.length / tokens.length >= 0.5;
  return { pass, tokens, hits };
}

async function runLiveEval({ model, apiKey, skillName, systemPrompt, evalCase }) {
  let output, usage, error;
  try {
    const res = await callClaude({ model, system: systemPrompt, userPrompt: evalCase.prompt, apiKey });
    output = res.output;
    usage = res.usage;
  } catch (err) {
    error = String(err.message || err);
  }
  if (error) return { id: evalCase.id, ok: false, error };
  const assertions = evalCase.assertions.map((a) => ({ assertion: a, ...scoreAssertion(output, a) }));
  const passedCount = assertions.filter((a) => a.pass).length;
  return {
    id: evalCase.id,
    ok: passedCount === assertions.length,
    passedAssertions: passedCount,
    totalAssertions: assertions.length,
    output: output.slice(0, 2000),
    usage,
    assertions,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); return; }

  if (args.live && !args.model) {
    process.stderr.write('--live requires --model <model-id>\n');
    process.exit(2);
  }
  const apiKey = args.live ? process.env.ANTHROPIC_API_KEY : null;
  if (args.live && !apiKey) {
    process.stderr.write('ANTHROPIC_API_KEY env var required for --live mode\n');
    process.exit(2);
  }

  const skills = listSkillDirs(args.skill);
  if (skills.length === 0) {
    process.stderr.write(args.skill ? `skill not found: ${args.skill}\n` : 'no skills found under skills/\n');
    process.exit(2);
  }

  const report = {
    schema: 'modern-skills.eval-report.v1',
    generatedAt: new Date().toISOString(),
    mode: args.live ? 'live' : 'dry-run',
    model: args.model || null,
    skillsScanned: skills.length,
    skills: [],
  };
  let anyError = false;

  for (const skillName of skills) {
    const skillReport = { name: skillName, ok: true };
    const evalsObj = readEvalsFile(skillName);
    if (!evalsObj) {
      skillReport.ok = false;
      skillReport.error = 'evals/evals.json missing';
      report.skills.push(skillReport);
      anyError = true;
      continue;
    }
    const structuralErrors = validateEvalsFile(skillName, evalsObj);
    if (structuralErrors.length) {
      skillReport.ok = false;
      skillReport.structuralErrors = structuralErrors;
      report.skills.push(skillReport);
      anyError = true;
      continue;
    }
    skillReport.evalCount = evalsObj.evals.length;
    skillReport.assertionCount = evalsObj.evals.reduce((n, e) => n + e.assertions.length, 0);

    if (args.live) {
      const systemPrompt = readSkillContent(skillName);
      skillReport.evals = [];
      // Run evals in chunks of maxParallel
      const queue = [...evalsObj.evals];
      while (queue.length) {
        const batch = queue.splice(0, args.maxParallel);
        const results = await Promise.all(batch.map((e) => runLiveEval({ model: args.model, apiKey, skillName, systemPrompt, evalCase: e })));
        skillReport.evals.push(...results);
      }
      const fails = skillReport.evals.filter((e) => !e.ok);
      if (fails.length) { skillReport.ok = false; anyError = true; }
      skillReport.passed = skillReport.evals.length - fails.length;
      skillReport.failed = fails.length;
    }
    report.skills.push(skillReport);
  }

  report.ok = !anyError;
  console.log(JSON.stringify(report, null, 2));
  process.exit(anyError ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`run-skill-evals: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
