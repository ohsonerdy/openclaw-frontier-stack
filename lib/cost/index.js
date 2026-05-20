'use strict';

/**
 * lib/cost — per-goal USD cost estimator.
 *
 * The orchestrator records token usage from agent backends in each goal's
 * persisted state. This module turns `{ model, usage }` records into a USD
 * estimate using `lib/cost-table.json` (or a user-supplied table via the
 * `OPENCLAW_COST_TABLE` env var).
 *
 * This is an ESTIMATE only. Pricing changes regularly and the table is a
 * snapshot. Operators who care about actual billing should consult their
 * provider's billing surface; we use the estimate for capacity planning
 * and goal-cost visibility in the CLI.
 *
 * No runtime deps. Pure Node.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const BUILTIN_TABLE_PATH = path.join(PACKAGE_ROOT, 'lib', 'cost-table.json');

let _cached = null;
let _cachedSource = null;

function loadCostTable({ tablePath = null } = {}) {
  const envPath = process.env.OPENCLAW_COST_TABLE;
  const source = tablePath || envPath || BUILTIN_TABLE_PATH;
  if (_cached && _cachedSource === source) return _cached;
  let raw;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (err) {
    if (source !== BUILTIN_TABLE_PATH) {
      // Operator-supplied path — fail loud so a typo doesn't silently fall back.
      throw new Error(`cost-table not readable at ${source}: ${err.message}`);
    }
    // Built-in missing is fatal — the package ships it.
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cost-table at ${source} is not JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`cost-table at ${source} is not an object`);
  }
  if (!parsed.models || typeof parsed.models !== 'object') {
    throw new Error(`cost-table at ${source} missing models map`);
  }
  _cached = parsed;
  _cachedSource = source;
  return parsed;
}

function resetCostTableCacheForTests() {
  _cached = null;
  _cachedSource = null;
}

function resolveModelRate(table, modelId) {
  if (!modelId) return null;
  const direct = table.models[modelId];
  if (direct) return { modelId, rate: direct, source: 'direct' };
  const aliases = table.aliases || {};
  if (aliases[modelId] && table.models[aliases[modelId]]) {
    return { modelId: aliases[modelId], rate: table.models[aliases[modelId]], source: 'alias' };
  }
  // Soft-match by prefix (e.g. claude-sonnet-4-6-20251022 → claude-sonnet-4-6).
  for (const key of Object.keys(table.models)) {
    if (modelId.startsWith(key)) {
      return { modelId: key, rate: table.models[key], source: 'prefix' };
    }
  }
  if (table.fallback) {
    return { modelId: 'fallback', rate: table.fallback, source: 'fallback' };
  }
  return null;
}

/**
 * Normalise a backend `usage` block into a flat `{ input, output, cache_write,
 * cache_read }` token-count shape. Both Anthropic and OpenAI variants are
 * accepted. Anything missing is 0.
 *
 *   Anthropic:  { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *   OpenAI:     { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } }
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  }
  const get = (...keys) => {
    for (const k of keys) {
      const path = k.split('.');
      let v = usage;
      for (const p of path) v = v && typeof v === 'object' ? v[p] : undefined;
      if (typeof v === 'number') return v;
    }
    return 0;
  };
  return {
    input: get('input_tokens', 'prompt_tokens'),
    output: get('output_tokens', 'completion_tokens'),
    cache_write: get('cache_creation_input_tokens', 'prompt_tokens_details.cached_creation_tokens'),
    cache_read: get('cache_read_input_tokens', 'prompt_tokens_details.cached_tokens'),
  };
}

/**
 * Estimate USD cost for one model call. Returns:
 *   { usd, modelId, modelResolved, usage, perRate }
 *
 *   usd          — total USD (rounded to 6 decimals, never negative)
 *   modelId      — the model id as supplied
 *   modelResolved — { modelId, source } showing which table entry was used
 *   usage        — normalised input/output/cache token counts
 *   perRate      — usd broken down per-rate-type
 */
function estimateCallCost({ model, usage }, { table = null } = {}) {
  const t = table || loadCostTable();
  const norm = normalizeUsage(usage);
  const resolved = resolveModelRate(t, model);
  if (!resolved) {
    return {
      usd: 0,
      modelId: model || null,
      modelResolved: null,
      usage: norm,
      perRate: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    };
  }
  const rate = resolved.rate;
  const perRate = {
    input: (norm.input * (rate.input || 0)) / 1_000_000,
    output: (norm.output * (rate.output || 0)) / 1_000_000,
    cache_write: (norm.cache_write * (rate.cache_write || 0)) / 1_000_000,
    cache_read: (norm.cache_read * (rate.cache_read || 0)) / 1_000_000,
  };
  const total = perRate.input + perRate.output + perRate.cache_write + perRate.cache_read;
  return {
    usd: Math.max(0, Math.round(total * 1_000_000) / 1_000_000),
    modelId: model || null,
    modelResolved: { modelId: resolved.modelId, source: resolved.source },
    usage: norm,
    perRate,
  };
}

/**
 * Sum a list of per-call estimates. Returns:
 *   { usd, callCount, usage, perModel }
 */
function sumCosts(callEstimates) {
  const totals = {
    usd: 0,
    callCount: 0,
    usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    perModel: {},
  };
  for (const est of callEstimates || []) {
    if (!est || typeof est.usd !== 'number') continue;
    totals.callCount += 1;
    totals.usd += est.usd;
    for (const k of Object.keys(totals.usage)) totals.usage[k] += est.usage[k] || 0;
    const modelKey = (est.modelResolved && est.modelResolved.modelId) || est.modelId || 'unknown';
    if (!totals.perModel[modelKey]) {
      totals.perModel[modelKey] = { usd: 0, callCount: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 };
    }
    totals.perModel[modelKey].usd += est.usd;
    totals.perModel[modelKey].callCount += 1;
    for (const k of ['input', 'output', 'cache_write', 'cache_read']) {
      totals.perModel[modelKey][k] += est.usage[k] || 0;
    }
  }
  totals.usd = Math.round(totals.usd * 1_000_000) / 1_000_000;
  return totals;
}

module.exports = {
  loadCostTable,
  resetCostTableCacheForTests,
  resolveModelRate,
  normalizeUsage,
  estimateCallCost,
  sumCosts,
  BUILTIN_TABLE_PATH,
};
