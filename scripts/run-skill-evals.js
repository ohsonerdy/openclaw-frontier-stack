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
 *      Same plan, but for each eval also calls a model backend with the
 *      eval prompt loaded against the SKILL.md as system prompt. Returns
 *      the model output and a per-assertion check (substring/regex match
 *      heuristic).
 *
 *      Default backend is Anthropic (https://api.anthropic.com). Pass
 *      --endpoint and --api-format to target an OpenAI-compatible server
 *      such as Ollama (http://localhost:11434) or vLLM
 *      (http://localhost:8000).
 *
 * Usage:
 *
 *   node scripts/run-skill-evals.js                      # dry-run, all skills
 *   node scripts/run-skill-evals.js --skill cro          # dry-run, one skill
 *   node scripts/run-skill-evals.js --live --model claude-sonnet-4-6
 *   node scripts/run-skill-evals.js --live --skill cro --model claude-opus-4-7
 *   node scripts/run-skill-evals.js --live --model llama3 \
 *       --endpoint http://localhost:11434 --api-format openai
 *
 * Output: JSON to stdout. Non-zero exit if any eval file is malformed (dry-run)
 * or if any assertion fails (live mode).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const root = path.resolve(__dirname, '..');
const skillsDir = path.join(root, 'skills');

const DEFAULT_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';

function parseArgs(argv) {
  const args = {
    live: false,
    model: null,
    skill: null,
    maxParallel: 4,
    endpoint: null,
    apiFormat: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--skill') args.skill = argv[++i];
    else if (a === '--max-parallel') args.maxParallel = Number(argv[++i]) || 4;
    else if (a === '--endpoint') args.endpoint = argv[++i];
    else if (a === '--api-format') args.apiFormat = argv[++i];
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
  Live (--live):      calls a model backend with each eval, scores assertions

Auth for --live (Anthropic backend, priority order):
  ANTHROPIC_OAUTH_TOKEN    Preferred. Charges your Pro/Max subscription.
  CLAUDE_CODE_OAUTH_TOKEN  Alias for ANTHROPIC_OAUTH_TOKEN.
  ANTHROPIC_API_KEY        Fallback. Charges per-token via API billing.
                           Opt in only if you want pay-per-token instead
                           of subscription billing.

Auth for --live (OpenAI-compatible backend, priority order):
  OPENCLAW_EVAL_API_KEY    Preferred. Sent as Bearer token.
  OPENAI_API_KEY           Fallback. Sent as Bearer token.
                           If neither is set and the endpoint is localhost
                           or 127.0.0.1 (e.g. Ollama default), no auth
                           header is sent. Remote endpoints require a key.

Flags:
  --live                 Enable live mode
  --model <model-id>     Model id (live mode only)
                         Anthropic examples: claude-opus-4-7, claude-sonnet-4-6,
                           claude-haiku-4-5-20251001
                         Ollama / vLLM examples: llama3, qwen2.5:14b,
                           mistralai/Mistral-7B-Instruct-v0.3
  --endpoint <url>       Backend base URL (env: OPENCLAW_EVAL_ENDPOINT)
                         Default: https://api.anthropic.com
                         Examples: http://localhost:11434 (Ollama),
                                   http://localhost:8000 (vLLM)
  --api-format <fmt>     "anthropic" or "openai" (env: OPENCLAW_EVAL_API_FORMAT)
                         Default: anthropic for api.anthropic.com,
                                  openai for any other endpoint
  --skill <skill-name>   Run only this skill (default: all)
  --max-parallel <n>     Max concurrent live calls (default 4, ignored in dry-run)
  --help                 Show this help

Exit codes:
  0  All evals passed (live) or all eval files valid (dry-run)
  1  Any eval failed (live) or any eval file malformed (dry-run)
  2  Bad CLI arguments or auth missing
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

function isLocalHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

function resolveBackend(args) {
  // Endpoint resolution: --endpoint > OPENCLAW_EVAL_ENDPOINT > default Anthropic.
  const rawEndpoint = (args.endpoint || process.env.OPENCLAW_EVAL_ENDPOINT || DEFAULT_ANTHROPIC_ENDPOINT).trim();
  let endpointUrl;
  try {
    endpointUrl = new URL(rawEndpoint);
  } catch (err) {
    throw new Error(`invalid endpoint URL: ${rawEndpoint}`);
  }

  // Format resolution: --api-format > OPENCLAW_EVAL_API_FORMAT > inferred from host.
  let apiFormat = (args.apiFormat || process.env.OPENCLAW_EVAL_API_FORMAT || '').trim().toLowerCase();
  if (!apiFormat) {
    apiFormat = endpointUrl.hostname.toLowerCase() === 'api.anthropic.com' ? 'anthropic' : 'openai';
  }
  if (apiFormat !== 'anthropic' && apiFormat !== 'openai') {
    throw new Error(`invalid --api-format: ${apiFormat} (expected "anthropic" or "openai")`);
  }

  return { endpointUrl, apiFormat };
}

function resolveAuth({ endpointUrl, apiFormat }) {
  // Returns { kind, token } | { kind: 'none' } | throws on missing required auth.
  if (apiFormat === 'anthropic') {
    const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (oauthToken) return { kind: 'oauth', token: oauthToken };
    if (apiKey) return { kind: 'api-key', token: apiKey };
    throw new Error([
      '--live mode against an Anthropic endpoint requires one of:',
      '  ANTHROPIC_OAUTH_TOKEN  (preferred — charged to your Pro/Max subscription)',
      '  CLAUDE_CODE_OAUTH_TOKEN  (alias)',
      '  ANTHROPIC_API_KEY      (fallback — charged per-token via API billing)',
      '',
      'Generate an OAuth token via Claude Code (`/login`) or export an existing',
      'session token. Use ANTHROPIC_API_KEY only if you explicitly want API',
      'billing instead of subscription billing.',
    ].join('\n'));
  }
  // OpenAI-compatible path.
  const openclaw = process.env.OPENCLAW_EVAL_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  const token = openclaw || openai;
  if (token) return { kind: 'bearer', token };
  if (isLocalHost(endpointUrl.hostname)) return { kind: 'none' };
  throw new Error([
    `--live mode against ${endpointUrl.origin} requires one of:`,
    '  OPENCLAW_EVAL_API_KEY  (preferred)',
    '  OPENAI_API_KEY         (fallback)',
    '',
    'A local endpoint (localhost / 127.0.0.1) such as a default Ollama install',
    'can run without auth — but this endpoint is remote, so a key is required.',
  ].join('\n'));
}

function httpRequest({ endpointUrl, pathSuffix, headers, body }) {
  // Builds a request against endpointUrl + pathSuffix, picking https vs http.
  const target = new URL(pathSuffix, endpointUrl);
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers,
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => {
      // Normalise common network errors so the failure message is operator-readable.
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH' || err.code === 'ETIMEDOUT')) {
        reject(new Error(`endpoint unreachable (${err.code}): ${endpointUrl.origin}`));
        return;
      }
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function callAnthropic({ model, system, userPrompt, auth, endpointUrl }) {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const headers = {
    'Content-Type': 'application/json',
    'Anthropic-Version': '2023-06-01',
    'Content-Length': Buffer.byteLength(body),
  };
  // Auth: OAuth token preferred (charged to user's Pro/Max subscription); fall back to API key (charged per-token).
  if (auth.kind === 'oauth') {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth.kind === 'api-key') {
    headers['X-Api-Key'] = auth.token;
  }
  const { statusCode, body: text } = await httpRequest({ endpointUrl, pathSuffix: '/v1/messages', headers, body });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad response (${statusCode}): ${text.slice(0, 500)}`);
  }
  if (statusCode >= 400) throw new Error(`${statusCode} ${parsed.error?.message || text}`);
  const output = (parsed.content || []).map((b) => b.text || '').join('\n').trim();
  return { output, usage: parsed.usage || null };
}

async function callOpenAICompatible({ model, system, userPrompt, auth, endpointUrl }) {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (auth.kind === 'bearer') {
    headers['Authorization'] = `Bearer ${auth.token}`;
  }
  const { statusCode, body: text } = await httpRequest({ endpointUrl, pathSuffix: '/v1/chat/completions', headers, body });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Bad response (${statusCode}): ${text.slice(0, 500)}`);
  }
  if (statusCode >= 400) {
    const msg = parsed.error?.message || parsed.error || text;
    throw new Error(`${statusCode} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  const choice = (parsed.choices || [])[0];
  const output = (choice?.message?.content || '').trim();
  return { output, usage: parsed.usage || null };
}

async function callModel(opts) {
  if (opts.apiFormat === 'anthropic') return callAnthropic(opts);
  return callOpenAICompatible(opts);
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

async function runLiveEval({ model, auth, apiFormat, endpointUrl, skillName, systemPrompt, evalCase }) {
  let output, usage, error;
  try {
    const res = await callModel({ model, system: systemPrompt, userPrompt: evalCase.prompt, auth, apiFormat, endpointUrl });
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

  let backend = null;
  let auth = null;
  if (args.live) {
    try {
      backend = resolveBackend(args);
      auth = resolveAuth(backend);
    } catch (err) {
      process.stderr.write(`${err.message}\n\n`);
      process.exit(2);
    }
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
    auth: args.live ? {
      kind: auth.kind,
      endpoint: backend.endpointUrl.origin,
      apiFormat: backend.apiFormat,
    } : null,
    skillsScanned: skills.length,
    skills: [],
  };
  let anyError = false;

  for (const skillName of skills) {
    const skillReport = { name: skillName, ok: true };
    const evalsObj = readEvalsFile(skillName);
    if (!evalsObj) {
      // Skills without evals.json are procedural/runbook-shaped (release-gate,
      // history scan, task ledger). They have no harness-testable assertions.
      // Report as skipped, not as a failure.
      skillReport.skipped = true;
      skillReport.reason = 'no-evals-file (procedural skill)';
      report.skills.push(skillReport);
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
        const results = await Promise.all(batch.map((e) => runLiveEval({
          model: args.model,
          auth,
          apiFormat: backend.apiFormat,
          endpointUrl: backend.endpointUrl,
          skillName,
          systemPrompt,
          evalCase: e,
        })));
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
