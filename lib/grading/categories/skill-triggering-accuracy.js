#!/usr/bin/env node
'use strict';

/**
 * lib/grading/categories/skill-triggering-accuracy.js
 *
 * Grading category: skill triggering accuracy.
 *
 * For each test case in lib/grading/fixtures/skill-trigger-cases.json:
 *   1. Build a system prompt containing a flat catalog of every skill's
 *      frontmatter `description:` line.
 *   2. Call the Anthropic backend with the test case's `request` as the user turn,
 *      asking the model to pick the most appropriate skill id (or "none").
 *   3. Compare to expectedSkill (single) or expectedSkills (any-of for ambiguous).
 *
 * Score = correct picks / total cases, expressed 0-100.
 *
 * Shares the auth, retry, timeout, concurrency, and cache plumbing structure
 * with skill-eval-live.js. Same fake-backend env-var path
 * (OPENCLAW_GRADE_FAKE_BACKEND) for test mode.
 *
 * Public interface:
 *   score(opts) -> { score, detail }
 *
 * CLI:
 *   node lib/grading/categories/skill-triggering-accuracy.js [--no-cache | --cache-only]
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
const CACHE_PATH = path.join(REPORTS_DIR, 'grade-skill-triggering-cache.json');
const CASES_PATH = path.join(PACKAGE_ROOT, 'lib', 'grading', 'fixtures', 'skill-trigger-cases.json');

const DEFAULT_MODEL = process.env.OPENCLAW_GRADE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_BACKOFFS_MS = [2_000, 4_000, 8_000];
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_RESPONSE_TRUNCATION = 2 * 1024;

const CACHE_SCHEMA = 'openclaw-frontier.grade-skill-triggering-cache.v1';
const REPORT_SCHEMA = 'openclaw-frontier.grade-skill-triggering.v1';

// ----------------------------------------------------------------------------
// Catalog assembly.
// ----------------------------------------------------------------------------

function loadSkillCatalog() {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillId = e.name;
    const skillMdPath = path.join(SKILLS_DIR, skillId, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const description = extractDescription(content);
    if (description) items.push({ skillId, description });
  }
  items.sort((a, b) => a.skillId.localeCompare(b.skillId));
  return items;
}

function extractDescription(skillMdContent) {
  // Parse the frontmatter and pull the `description:` value, handling both
  // single-line and folded forms. Stops at the next top-level YAML key.
  const fmMatch = skillMdContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const lines = fm.split('\n');
  let inDesc = false;
  let collected = [];
  for (const line of lines) {
    if (!inDesc) {
      const m = line.match(/^description:\s*(.*)$/);
      if (m) {
        inDesc = true;
        if (m[1]) collected.push(m[1].trim());
        continue;
      }
    } else {
      // Continuation lines are indented; a top-level key (no leading ws + ':')
      // ends the description.
      if (/^\S+:/.test(line)) {
        inDesc = false;
        break;
      }
      collected.push(line.trim());
    }
  }
  return collected.join(' ').trim() || null;
}

function buildSystemPrompt(catalog) {
  const header = [
    'You are a routing classifier. Given a user request and a catalog of available skills,',
    'pick the single most appropriate skill id, or reply "none" if no skill fits.',
    '',
    'Reply with ONLY the skill id (the part before the colon), or "none". No explanation.',
    '',
    'Catalog:',
    '',
  ].join('\n');
  const body = catalog
    .map((s) => `${s.skillId}: ${s.description}`)
    .join('\n');
  return `${header}${body}\n`;
}

function buildUserPrompt(request) {
  return [
    'User request:',
    '"""',
    request,
    '"""',
    '',
    'Which skill id from the catalog best fits this request? Reply with the skill id only, or "none".',
  ].join('\n');
}

function normalizePick(raw, catalog) {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text || text === 'none' || text === '"none"' || text === 'null') return 'none';
  // The model may wrap with quotes, backticks, or include trailing punctuation.
  const cleaned = text
    .replace(/^["'`]+/, '')
    .replace(/["'`.,;:]+$/g, '')
    .split(/\s+/)[0];
  // Match against catalog ids (case insensitive).
  const catalogIds = catalog.map((s) => s.skillId.toLowerCase());
  if (catalogIds.includes(cleaned)) return cleaned;
  // Try a contains match if the model paraphrased.
  const contained = catalog.find((s) => text.includes(s.skillId.toLowerCase()));
  if (contained) return contained.skillId;
  return cleaned;
}

// ----------------------------------------------------------------------------
// Cases file.
// ----------------------------------------------------------------------------

function loadCases() {
  if (!fs.existsSync(CASES_PATH)) {
    throw new Error(`trigger cases file not found at ${CASES_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`trigger cases file at ${CASES_PATH} is missing 'cases' array`);
  }
  return parsed.cases;
}

function expectedPickMatches(pick, c) {
  if (!pick) return false;
  if (Array.isArray(c.expectedSkills) && c.expectedSkills.length > 0) {
    return c.expectedSkills.map((s) => String(s).toLowerCase()).includes(String(pick).toLowerCase());
  }
  if (typeof c.expectedSkill === 'string') {
    const expected = c.expectedSkill.toLowerCase();
    if (expected === 'null' || expected === 'none' || expected === '') {
      return pick === 'none';
    }
    return expected === String(pick).toLowerCase();
  }
  return false;
}

// ----------------------------------------------------------------------------
// Cache (per-case key over request + model).
// ----------------------------------------------------------------------------

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return { schema: CACHE_SCHEMA, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (parsed && parsed.schema === CACHE_SCHEMA && parsed.entries) return parsed;
  } catch (_) { /* fall through */ }
  return { schema: CACHE_SCHEMA, entries: {} };
}

function saveCache(cache) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function hashCase({ catalogHash, request }) {
  return crypto
    .createHash('sha256')
    .update(catalogHash)
    .update(' ')
    .update(request)
    .digest('hex');
}

function catalogHash(catalog) {
  return crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

function cacheKey({ caseId, catalogPromptHash, modelName }) {
  return `${caseId}::${modelName}::${catalogPromptHash}`;
}

function cacheLookup(cache, key, now) {
  const entry = cache.entries[key];
  if (!entry) return null;
  const age = now - new Date(entry.scoredAt).getTime();
  if (Number.isNaN(age) || age < 0 || age > CACHE_MAX_AGE_MS) return null;
  return entry;
}

// ----------------------------------------------------------------------------
// Concurrency + retry (mirrors skill-eval-live.js).
// ----------------------------------------------------------------------------

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
// Backend impl (production or fake).
// ----------------------------------------------------------------------------

function makeBackendImpl(fakeBackendPath) {
  if (!fakeBackendPath) return { call: callBackend, isFake: false };
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fakeBackendPath, 'utf8'));
  } catch (err) {
    throw new Error(`fake-backend fixture not readable at ${fakeBackendPath}: ${err.message}`);
  }
  const callCounts = new Map();
  // Fixture shape:
  //   { default: 'none', cases: { 'caseId': { output, usage, error, transientErrors, delayMs } } }
  return {
    isFake: true,
    fixture,
    call: async ({ userPrompt }) => {
      const matchKey = Object.keys(fixture.cases || {}).find((k) => (userPrompt || '').includes(k));
      const entry = matchKey ? fixture.cases[matchKey] : null;
      const n = (callCounts.get(matchKey) || 0) + 1;
      callCounts.set(matchKey, n);
      if (entry && Array.isArray(entry.transientErrors) && n <= entry.transientErrors.length) {
        throw new Error(entry.transientErrors[n - 1]);
      }
      if (entry && entry.error) throw new Error(entry.error);
      if (entry && typeof entry.delayMs === 'number' && entry.delayMs > 0) {
        await delay(entry.delayMs);
      }
      return {
        output: (entry && entry.output) || fixture.default || 'none',
        usage: (entry && entry.usage) || { input_tokens: 80, output_tokens: 10 },
      };
    },
  };
}

// ----------------------------------------------------------------------------
// Scoring entry-point.
// ----------------------------------------------------------------------------

async function score(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fakeBackendPath = process.env.OPENCLAW_GRADE_FAKE_BACKEND;
  const callImpl = opts.callBackendImpl || makeBackendImpl(fakeBackendPath);

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

  let cases;
  try { cases = loadCases(); } catch (err) {
    return { score: null, detail: `cases-file-error:${err.message}` };
  }
  if (cases.length === 0) return { score: null, detail: 'no-trigger-cases' };

  const catalog = loadSkillCatalog();
  const catH = catalogHash(catalog);
  const systemPrompt = buildSystemPrompt(catalog);

  const cache = opts.noCache ? { schema: CACHE_SCHEMA, entries: {} } : loadCache();
  const now = Date.now();
  const callEstimates = [];
  let totalLatencyMs = 0;
  let cacheHits = 0;
  let cacheWrites = 0;
  let skipped = 0;
  let failed = 0;
  let correct = 0;
  let incorrect = 0;
  let rateLimited = 0;
  let timedOut = 0;

  let costTable = null;
  try { costTable = loadCostTable(); } catch (_) { /* non-fatal */ }

  const distribution = { 'clear-match': 0, 'oblique-match': 0, 'no-match': 0, ambiguous: 0, unlabeled: 0 };
  for (const c of cases) {
    const k = c.kind || 'unlabeled';
    distribution[k] = (distribution[k] || 0) + 1;
  }

  const results = await runConcurrent(cases, concurrency, async (c) => {
    const requestHash = hashCase({ catalogHash: catH, request: c.request });
    const key = cacheKey({ caseId: c.id, catalogPromptHash: requestHash, modelName: model });

    if (!opts.noCache) {
      const hit = cacheLookup(cache, key, now);
      if (hit) {
        cacheHits += 1;
        const pick = normalizePick(hit.response, catalog);
        const isCorrect = expectedPickMatches(pick, c);
        if (isCorrect) correct += 1; else incorrect += 1;
        return {
          id: c.id,
          kind: c.kind,
          cached: true,
          pick,
          expected: c.expectedSkills || c.expectedSkill,
          correct: isCorrect,
        };
      }
    }

    if (opts.cacheOnly) {
      skipped += 1;
      return { id: c.id, kind: c.kind, cached: false, skipped: true, reason: 'cache-miss-in-cache-only-mode' };
    }

    const startedAt = Date.now();
    const call = await callWithRetry({
      backendImpl: callImpl.call,
      backendArgs: {
        model,
        system: systemPrompt,
        userPrompt: buildUserPrompt(c.request),
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
      incorrect += 1;
      return {
        id: c.id,
        kind: c.kind,
        cached: false,
        failed: true,
        error: normalized,
        errorDetail: errMsg.slice(0, 200),
        attempts: call.attempts,
        latencyMs,
        correct: false,
      };
    }

    const output = (call.output || '').trim();
    const pick = normalizePick(output, catalog);
    const isCorrect = expectedPickMatches(pick, c);
    if (isCorrect) correct += 1; else incorrect += 1;

    if (costTable && call.usage) {
      try {
        callEstimates.push(estimateCallCost({ model, usage: call.usage }, { table: costTable }));
      } catch (_) { /* non-fatal */ }
    }

    if (!opts.noCache) {
      cacheWrites += 1;
      cache.entries[key] = {
        caseId: c.id,
        catalogPromptHash: requestHash,
        modelName: model,
        response: output.slice(0, CACHE_RESPONSE_TRUNCATION),
        scoredAt: new Date().toISOString(),
        pick,
      };
    }

    return {
      id: c.id,
      kind: c.kind,
      cached: false,
      pick,
      expected: c.expectedSkills || c.expectedSkill,
      correct: isCorrect,
      latencyMs,
      attempts: call.attempts,
    };
  });

  if (!opts.noCache && cacheWrites > 0) saveCache(cache);

  const total = results.length;
  const finalScore = total > 0 ? Math.round((correct / total) * 10_000) / 100 : 0;
  const totals = sumCosts(callEstimates);

  // Per-kind accuracy breakdown.
  const perKind = {};
  for (const r of results) {
    const k = r.kind || 'unlabeled';
    if (!perKind[k]) perKind[k] = { total: 0, correct: 0 };
    perKind[k].total += 1;
    if (r.correct) perKind[k].correct += 1;
  }

  return {
    score: finalScore,
    detail: {
      schema: REPORT_SCHEMA,
      totalCases: total,
      correct,
      incorrect,
      failed,
      skipped,
      cacheHits,
      cacheWrites,
      rateLimited,
      timedOut,
      modelUsed: model,
      totalCostUsd: totals.usd,
      totalLatencyMs,
      catalogSize: catalog.length,
      distribution,
      perKind,
    },
  };
}

// ----------------------------------------------------------------------------
// CLI.
// ----------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { noCache: false, cacheOnly: false, model: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-cache') args.noCache = true;
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
    'skill-triggering-accuracy.js - Tier-3 triggering-accuracy grading category.',
    '',
    'Usage:',
    '  node lib/grading/categories/skill-triggering-accuracy.js [--no-cache | --cache-only]',
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
  ].join('\n'));
}

async function cli() {
  const args = parseCliArgs(process.argv);
  if (args.help) { help(); return; }
  const res = await score({
    model: args.model,
    noCache: args.noCache,
    cacheOnly: args.cacheOnly,
  });
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  if (res.score == null) process.exit(2);
  process.exit(res.score >= 90 ? 0 : 1);
}

if (require.main === module) {
  cli().catch((err) => {
    process.stderr.write(`skill-triggering-accuracy: ${err.stack || err.message || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  score,
  _internal: {
    extractDescription,
    loadSkillCatalog,
    buildSystemPrompt,
    buildUserPrompt,
    normalizePick,
    loadCases,
    expectedPickMatches,
    hashCase,
    catalogHash,
    cacheKey,
    cacheLookup,
    runConcurrent,
    runWithTimeout,
    isRetryableError,
    callWithRetry,
    CASES_PATH,
    CACHE_PATH,
    CACHE_SCHEMA,
  },
};
