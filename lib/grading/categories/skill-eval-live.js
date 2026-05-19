#!/usr/bin/env node
'use strict';

/**
 * lib/grading/categories/skill-eval-live.js
 *
 * Tier-3 grading category: live skill eval against a real frontier model.
 *
 * For every skills/<id>/evals/evals.json case, this category:
 *   1. Renders the case prompt with the corresponding SKILL.md as system content.
 *   2. Calls the Anthropic backend (via scripts/run-skill-evals.js#callBackend).
 *   3. Scores the model output against the case's assertions.
 *   4. Aggregates per-skill pass rates and an overall score.
 *
 * Auth order: ANTHROPIC_OAUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY.
 * Missing all three -> { score: null, detail: 'no-anthropic-credential; set ANTHROPIC_OAUTH_TOKEN' }.
 *
 * Concurrency: 8 in-flight calls (rate-limit safe for the OAuth tier).
 * Retry: 429 / 5xx -> exponential backoff 2s/4s/8s, max 3 retries.
 * Timeout: 60s per call (timeout = case fail).
 *
 * Cache: release-gate/reports/grade-skill-eval-live-cache.json
 *   - Keyed by promptHash + modelName.
 *   - Cache age: 30 days.
 *   - --no-cache invalidates. --cache-only forces cache-miss = case skipped.
 *
 * Cost: tracked via lib/cost-table.json, summed across all calls.
 *
 * Public interface for scripts/grade.js (G2a):
 *   score(opts) -> { score, detail }
 *
 * CLI debug helpers:
 *   node lib/grading/categories/skill-eval-live.js --skill <id>
 *   node lib/grading/categories/skill-eval-live.js --all [--no-cache | --cache-only]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  callBackend,
  resolveBackend,
  resolveAuth,
} = require('../../../scripts/run-skill-evals.js');

const { estimateCallCost, sumCosts, loadCostTable } = require('../../cost');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');
const REPORTS_DIR = path.join(PACKAGE_ROOT, 'release-gate', 'reports');
const CACHE_PATH = path.join(REPORTS_DIR, 'grade-skill-eval-live-cache.json');

const DEFAULT_MODEL = process.env.OPENCLAW_GRADE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_BACKOFFS_MS = [2_000, 4_000, 8_000];
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_RESPONSE_TRUNCATION = 8 * 1024;

const CACHE_SCHEMA = 'openclaw-frontier.grade-skill-eval-live-cache.v1';
const REPORT_SCHEMA = 'openclaw-frontier.grade-skill-eval-live.v1';

// ----------------------------------------------------------------------------
// Filesystem helpers.
// ----------------------------------------------------------------------------

function listSkillDirs(filter) {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !filter || n === filter)
    .sort();
}

function readEvalsFile(skillName) {
  const p = path.join(SKILLS_DIR, skillName, 'evals', 'evals.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { __parseError: String(err.message || err) };
  }
}

function readSkillContent(skillName) {
  const p = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// ----------------------------------------------------------------------------
// Cache.
// ----------------------------------------------------------------------------

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    return { schema: CACHE_SCHEMA, entries: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (parsed && parsed.schema === CACHE_SCHEMA && parsed.entries) return parsed;
  } catch (_) {
    // Corrupted cache - reset.
  }
  return { schema: CACHE_SCHEMA, entries: {} };
}

function saveCache(cache) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function cacheKey({ skillId, caseId, promptHash, modelName }) {
  return `${skillId}::${caseId}::${modelName}::${promptHash}`;
}

function cacheLookup(cache, key, now) {
  const entry = cache.entries[key];
  if (!entry) return null;
  const age = now - new Date(entry.scoredAt).getTime();
  if (Number.isNaN(age) || age < 0 || age > CACHE_MAX_AGE_MS) return null;
  return entry;
}

function cacheWrite(cache, key, entry) {
  cache.entries[key] = entry;
}

function hashPrompt({ skillContent, casePrompt }) {
  return crypto
    .createHash('sha256')
    .update(skillContent)
    .update('\x1f')
    .update(casePrompt)
    .digest('hex');
}

// ----------------------------------------------------------------------------
// Assertion scoring.
//
// Supports both shapes seen in evals.json:
//   1. Plain string ("Walks the message-match framework")
//      -> token-extraction heuristic (matches scripts/run-skill-evals.js).
//   2. Typed object ({ type: 'contains'|'not-contains'|'length-at-least', value })
//      -> deterministic check.
// ----------------------------------------------------------------------------

function scoreStringAssertion(output, assertion) {
  const tokens = (assertion.match(/(?:modern\.[a-z_.]+|[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*|[a-z_-]{4,})/g) || [])
    .map((t) => t.toLowerCase())
    .filter((t, i, a) => a.indexOf(t) === i);
  const lowOut = output.toLowerCase();
  const hits = tokens.filter((t) => lowOut.includes(t));
  const pass = tokens.length === 0 ? false : hits.length / tokens.length >= 0.5;
  return { pass, kind: 'string-heuristic', hitRatio: tokens.length ? hits.length / tokens.length : 0 };
}

function scoreTypedAssertion(output, assertion) {
  const t = String(assertion.type || '').toLowerCase();
  const v = assertion.value;
  if (t === 'contains') {
    return { pass: String(output || '').toLowerCase().includes(String(v || '').toLowerCase()), kind: t };
  }
  if (t === 'not-contains') {
    return { pass: !String(output || '').toLowerCase().includes(String(v || '').toLowerCase()), kind: t };
  }
  if (t === 'length-at-least') {
    return { pass: String(output || '').length >= Number(v || 0), kind: t };
  }
  return { pass: false, kind: `unknown:${t}` };
}

function scoreAssertion(output, assertion) {
  if (typeof assertion === 'string') return scoreStringAssertion(output, assertion);
  if (assertion && typeof assertion === 'object' && 'type' in assertion) {
    return scoreTypedAssertion(output, assertion);
  }
  return { pass: false, kind: 'invalid' };
}

function scoreCase(output, assertions) {
  const results = assertions.map((a) => ({ assertion: a, ...scoreAssertion(output, a) }));
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  return { results, passed, total, pass: total > 0 && passed === total };
}

// ----------------------------------------------------------------------------
// Concurrency + retry.
// ----------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout(promiseFn, timeoutMs) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promiseFn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableError(err) {
  const msg = String((err && err.message) || err || '');
  if (/^timeout:/.test(msg)) return false;
  if (/\b429\b/.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (/endpoint unreachable/.test(msg)) return true;
  return false;
}

async function callWithRetry({ backendImpl, backendArgs, timeoutMs }) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= RETRY_BACKOFFS_MS.length) {
    try {
      const res = await runWithTimeout(() => backendImpl(backendArgs), timeoutMs);
      return { ok: true, ...res, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= RETRY_BACKOFFS_MS.length) {
        return { ok: false, error: String(err.message || err), attempts: attempt + 1 };
      }
      await delay(RETRY_BACKOFFS_MS[attempt]);
      attempt += 1;
    }
  }
  return { ok: false, error: String(lastErr && lastErr.message || 'unknown'), attempts: attempt };
}

async function runConcurrent(items, concurrency, worker) {
  const out = new Array(items.length);
  let nextIndex = 0;
  const workers = [];
  for (let w = 0; w < Math.max(1, concurrency); w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ----------------------------------------------------------------------------
// Main scoring entry-point.
// ----------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.skill]              Limit to one skill id.
 * @param {string} [opts.model]              Model override (default: env or claude-sonnet-4-6).
 * @param {boolean} [opts.noCache]           Bypass cache entirely.
 * @param {boolean} [opts.cacheOnly]         Cache miss = skip case.
 * @param {number}  [opts.concurrency]       In-flight call cap (default: 8).
 * @param {number}  [opts.timeoutMs]         Per-call timeout (default: 60000).
 * @param {function} [opts.callBackendImpl]  Test injection - replaces callBackend.
 * @returns {Promise<{score: number|null, detail: object}>}
 */
async function score(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fakeBackendPath = process.env.OPENCLAW_GRADE_FAKE_BACKEND;
  const callImpl = opts.callBackendImpl || makeBackendImpl(fakeBackendPath);

  // Auth gating - skip live call if no credential and no fake backend.
  let backend = null;
  let auth = null;
  if (!callImpl.isFake) {
    try {
      backend = resolveBackend({ endpoint: null, apiFormat: null });
      auth = resolveAuth(backend);
    } catch (err) {
      if (/Anthropic|OAuth|API key/i.test(String(err.message || ''))) {
        return {
          score: null,
          detail: 'no-anthropic-credential; set ANTHROPIC_OAUTH_TOKEN',
        };
      }
      throw err;
    }
  } else {
    backend = { endpointUrl: new URL('http://fake.local'), apiFormat: 'anthropic' };
    auth = { kind: 'oauth', token: 'fake' };
  }

  const skills = listSkillDirs(opts.skill);
  if (skills.length === 0) {
    return {
      score: null,
      detail: opts.skill ? `skill-not-found:${opts.skill}` : 'no-skills-found',
    };
  }

  // Build the flat case queue.
  const queue = [];
  const skillReports = new Map();
  for (const skillId of skills) {
    const evalsObj = readEvalsFile(skillId);
    if (!evalsObj) {
      skillReports.set(skillId, {
        skillId,
        skipped: true,
        reason: 'no-evals-file',
        cases: [],
      });
      continue;
    }
    if (evalsObj.__parseError) {
      skillReports.set(skillId, {
        skillId,
        skipped: true,
        reason: `evals-parse-error:${evalsObj.__parseError}`,
        cases: [],
      });
      continue;
    }
    if (!Array.isArray(evalsObj.evals) || evalsObj.evals.length === 0) {
      skillReports.set(skillId, {
        skillId,
        skipped: true,
        reason: 'no-eval-cases',
        cases: [],
      });
      continue;
    }
    const skillContent = readSkillContent(skillId);
    skillReports.set(skillId, {
      skillId,
      skipped: false,
      cases: [],
      totalCases: evalsObj.evals.length,
      passedCases: 0,
    });
    for (const evalCase of evalsObj.evals) {
      queue.push({ skillId, skillContent, evalCase });
    }
  }

  const cache = opts.noCache ? { schema: CACHE_SCHEMA, entries: {} } : loadCache();
  const now = Date.now();
  const callEstimates = [];
  let totalLatencyMs = 0;
  let cacheHits = 0;
  let cacheWrites = 0;
  let skipped = 0;
  let failed = 0;
  let passed = 0;
  let rateLimited = 0;
  let timedOut = 0;

  let costTable = null;
  try { costTable = loadCostTable(); } catch (_) { /* missing table is non-fatal */ }

  const results = await runConcurrent(queue, concurrency, async (item) => {
    const { skillId, skillContent, evalCase } = item;
    const promptHash = hashPrompt({ skillContent, casePrompt: evalCase.prompt });
    const key = cacheKey({ skillId, caseId: evalCase.id, promptHash, modelName: model });

    if (!opts.noCache) {
      const hit = cacheLookup(cache, key, now);
      if (hit) {
        cacheHits += 1;
        const scored = scoreCase(hit.response || '', evalCase.assertions || []);
        if (scored.pass) passed += 1; else failed += 1;
        return {
          skillId,
          caseId: evalCase.id,
          cached: true,
          passed: scored.pass,
          passedAssertions: scored.passed,
          totalAssertions: scored.total,
          assertions: scored.results,
        };
      }
    }

    if (opts.cacheOnly) {
      skipped += 1;
      return {
        skillId,
        caseId: evalCase.id,
        cached: false,
        skipped: true,
        passed: false,
        reason: 'cache-miss-in-cache-only-mode',
      };
    }

    const startedAt = Date.now();
    const call = await callWithRetry({
      backendImpl: callImpl.call,
      backendArgs: {
        model,
        system: skillContent,
        userPrompt: evalCase.prompt,
        auth,
        apiFormat: backend.apiFormat,
        endpointUrl: backend.endpointUrl,
      },
      timeoutMs,
    });
    const latencyMs = Date.now() - startedAt;
    totalLatencyMs += latencyMs;

    if (!call.ok) {
      failed += 1;
      const errMsg = call.error || 'unknown';
      let normalized = 'error';
      if (/^timeout:/.test(errMsg)) { timedOut += 1; normalized = 'timeout'; }
      else if (/\b429\b/.test(errMsg) || /rate-limited/i.test(errMsg)) { rateLimited += 1; normalized = 'rate-limited'; }
      else if (/\b5\d\d\b/.test(errMsg)) { normalized = 'server-error'; }
      else if (/endpoint unreachable/.test(errMsg)) { normalized = 'unreachable'; }
      return {
        skillId,
        caseId: evalCase.id,
        cached: false,
        passed: false,
        failed: true,
        error: normalized,
        errorDetail: errMsg.slice(0, 200),
        attempts: call.attempts,
        latencyMs,
      };
    }

    const output = call.output || '';
    const scored = scoreCase(output, evalCase.assertions || []);
    if (scored.pass) passed += 1; else failed += 1;

    // Cost.
    if (costTable && call.usage) {
      try {
        const est = estimateCallCost({ model, usage: call.usage }, { table: costTable });
        callEstimates.push(est);
      } catch (_) { /* non-fatal */ }
    }

    // Cache write.
    if (!opts.noCache) {
      cacheWrites += 1;
      cacheWrite(cache, key, {
        skillId,
        caseId: evalCase.id,
        promptHash,
        modelName: model,
        response: output.slice(0, CACHE_RESPONSE_TRUNCATION),
        scoredAt: new Date().toISOString(),
        passed: scored.pass,
      });
    }

    return {
      skillId,
      caseId: evalCase.id,
      cached: false,
      passed: scored.pass,
      passedAssertions: scored.passed,
      totalAssertions: scored.total,
      assertions: scored.results,
      latencyMs,
      attempts: call.attempts,
    };
  });

  // Aggregate per-skill.
  for (const r of results) {
    const sr = skillReports.get(r.skillId);
    if (!sr) continue;
    sr.cases.push(r);
    if (r.passed) sr.passedCases = (sr.passedCases || 0) + 1;
  }

  if (!opts.noCache && cacheWrites > 0) {
    saveCache(cache);
  }

  // Build per-skill summary.
  const perSkill = [];
  let totalCases = 0;
  let totalPassed = 0;
  for (const sr of skillReports.values()) {
    if (sr.skipped) {
      perSkill.push({ skillId: sr.skillId, skipped: true, reason: sr.reason });
      continue;
    }
    const cases = sr.cases.length;
    totalCases += cases;
    totalPassed += sr.passedCases || 0;
    const skillScore = cases > 0 ? Math.round(((sr.passedCases || 0) / cases) * 10_000) / 100 : null;
    perSkill.push({
      skillId: sr.skillId,
      totalCases: cases,
      passedCases: sr.passedCases || 0,
      score: skillScore,
    });
  }

  const passRate = totalCases > 0 ? totalPassed / totalCases : 0;
  const finalScore = totalCases > 0 ? Math.round(passRate * 10_000) / 100 : 0;
  const totals = sumCosts(callEstimates);

  return {
    score: finalScore,
    detail: {
      schema: REPORT_SCHEMA,
      totalCases,
      passed: totalPassed,
      failed: totalCases - totalPassed,
      skipped,
      cacheHits,
      cacheWrites,
      rateLimited,
      timedOut,
      modelUsed: model,
      totalCostUsd: totals.usd,
      totalLatencyMs,
      perSkill,
    },
  };
}

// ----------------------------------------------------------------------------
// Fake backend (test injection).
// ----------------------------------------------------------------------------

function makeBackendImpl(fakeBackendPath) {
  if (!fakeBackendPath) {
    return { call: callBackend, isFake: false };
  }
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fakeBackendPath, 'utf8'));
  } catch (err) {
    throw new Error(`fake-backend fixture not readable at ${fakeBackendPath}: ${err.message}`);
  }
  // Per-key invocation counter so the fixture can model retryable failures
  // (transientErrors / transientCount) and slow calls (delayMs) deterministically.
  const callCounts = new Map();
  return {
    isFake: true,
    fixture,
    call: async ({ userPrompt, system }) => {
      // Match by a key fragment present in either the user prompt or the SKILL.md
      // system content. Tests author keys like "skill-id::case-id".
      const head = `${(system || '').slice(0, 400)}|${(userPrompt || '').slice(0, 400)}`;
      const matchKey = Object.keys(fixture.cases || {}).find((k) => head.includes(k));
      const entry = matchKey ? fixture.cases[matchKey] : null;
      const n = (callCounts.get(matchKey) || 0) + 1;
      callCounts.set(matchKey, n);

      if (entry && Array.isArray(entry.transientErrors) && n <= entry.transientErrors.length) {
        // Sequence of pre-success errors (e.g. "429 rate limit").
        throw new Error(entry.transientErrors[n - 1]);
      }
      if (entry && entry.error) {
        throw new Error(entry.error);
      }
      if (entry && typeof entry.delayMs === 'number' && entry.delayMs > 0) {
        await delay(entry.delayMs);
      }
      return {
        output: (entry && entry.output) || fixture.default || '',
        usage: (entry && entry.usage) || { input_tokens: 100, output_tokens: 200 },
      };
    },
  };
}

// ----------------------------------------------------------------------------
// CLI.
// ----------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { skill: null, all: false, noCache: false, cacheOnly: false, model: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--skill') args.skill = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '--cache-only') args.cacheOnly = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function help() {
  process.stdout.write([
    'skill-eval-live.js - Tier-3 live skill eval grading category.',
    '',
    'Usage:',
    '  node lib/grading/categories/skill-eval-live.js --skill <id>',
    '  node lib/grading/categories/skill-eval-live.js --all [--no-cache | --cache-only]',
    '  node lib/grading/categories/skill-eval-live.js --all --model claude-sonnet-4-6',
    '',
    'Auth (priority order):',
    '  ANTHROPIC_OAUTH_TOKEN     preferred (charged to subscription)',
    '  CLAUDE_CODE_OAUTH_TOKEN   alias',
    '  ANTHROPIC_API_KEY         fallback (per-token billing)',
    '',
    'Env:',
    '  OPENCLAW_GRADE_MODEL          model id override',
    '  OPENCLAW_GRADE_FAKE_BACKEND   path to a fixture JSON (test mode)',
    '',
    'Exit codes:',
    '  0  score >= 95',
    '  1  score < 95 (informational)',
    '  2  no credential / invalid args',
    '',
  ].join('\n'));
}

async function cli() {
  const args = parseCliArgs(process.argv);
  if (args.help) { help(); return; }
  if (!args.skill && !args.all) {
    process.stderr.write('one of --skill <id> | --all is required\n');
    process.exit(2);
  }
  const res = await score({
    skill: args.skill,
    model: args.model,
    noCache: args.noCache,
    cacheOnly: args.cacheOnly,
  });
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  if (res.score == null) process.exit(2);
  process.exit(res.score >= 95 ? 0 : 1);
}

if (require.main === module) {
  cli().catch((err) => {
    process.stderr.write(`skill-eval-live: ${err.stack || err.message || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  score,
  // Internals exposed for testing.
  _internal: {
    hashPrompt,
    cacheKey,
    cacheLookup,
    cacheWrite,
    scoreAssertion,
    scoreCase,
    callWithRetry,
    runConcurrent,
    runWithTimeout,
    isRetryableError,
    listSkillDirs,
    readEvalsFile,
    readSkillContent,
    CACHE_PATH,
    CACHE_SCHEMA,
    CACHE_MAX_AGE_MS,
    DEFAULT_MODEL,
  },
};
