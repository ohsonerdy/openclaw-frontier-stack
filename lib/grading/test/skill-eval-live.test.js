'use strict';

/**
 * Node-native tests for lib/grading/categories/skill-eval-live.js and
 * lib/grading/categories/skill-triggering-accuracy.js.
 *
 * All tests run in mock mode. No outbound network. The fake backend is
 * supplied either via the OPENCLAW_GRADE_FAKE_BACKEND env-var (CLI path)
 * or by injecting callBackendImpl directly (programmatic path).
 *
 * Coverage:
 *   - Assertion scoring (string heuristic + typed contains/not-contains/length).
 *   - Per-case pass aggregation and per-skill score.
 *   - Cache write + cache read (within and outside the 30-day window).
 *   - Concurrency does not drop or duplicate cases.
 *   - Retry kicks in on 429 / 5xx, gives up after RETRY_BACKOFFS exhausted.
 *   - Timeout marks the case as failed.
 *   - Trigger-accuracy normalization and expected-skill matching.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillEvalLive = require('../categories/skill-eval-live');
const triggering = require('../categories/skill-triggering-accuracy');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

function tmpDir(prefix = 'openclaw-grading-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeImpl(handler) {
  return { isFake: true, call: handler };
}

// ----------------------------------------------------------------------------
// Assertion-scoring tests (pure unit, no backend).
// ----------------------------------------------------------------------------

test('scoreAssertion: string heuristic passes when 50%+ tokens hit', () => {
  const { scoreAssertion } = skillEvalLive._internal;
  const out = 'Calls modern.attribution.first_touch grouped by landing_page, walks message-match framework.';
  const res = scoreAssertion(out, 'Calls modern.attribution.first_touch grouped by landing_page');
  assert.strictEqual(res.pass, true);
});

test('scoreAssertion: string heuristic fails when output ignores all tokens', () => {
  const { scoreAssertion } = skillEvalLive._internal;
  const res = scoreAssertion('Bake a cake. Add frosting.', 'Calls modern.attribution.first_touch grouped by landing_page');
  assert.strictEqual(res.pass, false);
});

test('scoreAssertion: typed contains', () => {
  const { scoreAssertion } = skillEvalLive._internal;
  assert.strictEqual(scoreAssertion('the trace_id flows through every log', { type: 'contains', value: 'trace_id' }).pass, true);
  assert.strictEqual(scoreAssertion('no trace correlation here', { type: 'contains', value: 'trace_id' }).pass, false);
});

test('scoreAssertion: typed not-contains', () => {
  const { scoreAssertion } = skillEvalLive._internal;
  assert.strictEqual(scoreAssertion('we should not just add the label', { type: 'not-contains', value: 'this is fine' }).pass, true);
  assert.strictEqual(scoreAssertion('this is fine, ship it', { type: 'not-contains', value: 'this is fine' }).pass, false);
});

test('scoreAssertion: typed length-at-least', () => {
  const { scoreAssertion } = skillEvalLive._internal;
  assert.strictEqual(scoreAssertion('x'.repeat(500), { type: 'length-at-least', value: 400 }).pass, true);
  assert.strictEqual(scoreAssertion('x'.repeat(50), { type: 'length-at-least', value: 400 }).pass, false);
});

test('scoreCase: case passes only when all assertions pass', () => {
  const { scoreCase } = skillEvalLive._internal;
  const out = 'trace_id flows through every log line and an integration test verifies it';
  const passed = scoreCase(out, [
    { type: 'contains', value: 'trace_id' },
    { type: 'contains', value: 'log line' },
    { type: 'contains', value: 'integration test' },
  ]);
  assert.strictEqual(passed.pass, true);
  assert.strictEqual(passed.passed, 3);

  const partial = scoreCase(out, [
    { type: 'contains', value: 'trace_id' },
    { type: 'contains', value: 'nonexistent' },
  ]);
  assert.strictEqual(partial.pass, false);
  assert.strictEqual(partial.passed, 1);
});

// ----------------------------------------------------------------------------
// Concurrency tests.
// ----------------------------------------------------------------------------

test('runConcurrent: processes all items exactly once', async () => {
  const { runConcurrent } = skillEvalLive._internal;
  const items = Array.from({ length: 50 }, (_, i) => i);
  let inflight = 0;
  let maxInflight = 0;
  const seen = new Set();
  const results = await runConcurrent(items, 8, async (item) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5));
    seen.add(item);
    inflight -= 1;
    return item * 2;
  });
  assert.strictEqual(results.length, 50);
  assert.strictEqual(seen.size, 50);
  for (let i = 0; i < 50; i += 1) assert.strictEqual(results[i], i * 2);
  assert.ok(maxInflight <= 8, `maxInflight ${maxInflight} exceeded 8`);
});

// ----------------------------------------------------------------------------
// Retry + timeout tests.
// ----------------------------------------------------------------------------

test('callWithRetry: retries on 429 and succeeds', async () => {
  const { callWithRetry } = skillEvalLive._internal;
  let n = 0;
  const impl = async () => {
    n += 1;
    if (n < 3) throw new Error('429 too many requests');
    return { output: 'ok', usage: { input_tokens: 10, output_tokens: 20 } };
  };
  const orig = global.setTimeout;
  // Speed up the backoff so the test isn't slow.
  global.setTimeout = (fn) => orig(fn, 1);
  try {
    const res = await callWithRetry({ backendImpl: impl, backendArgs: {}, timeoutMs: 5000 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.attempts, 3);
    assert.strictEqual(res.output, 'ok');
  } finally {
    global.setTimeout = orig;
  }
});

test('callWithRetry: gives up after RETRY_BACKOFFS exhausted', async () => {
  const { callWithRetry } = skillEvalLive._internal;
  let n = 0;
  const impl = async () => { n += 1; throw new Error('429 still throttled'); };
  const orig = global.setTimeout;
  global.setTimeout = (fn) => orig(fn, 1);
  try {
    const res = await callWithRetry({ backendImpl: impl, backendArgs: {}, timeoutMs: 5000 });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /429/);
    assert.ok(n >= 4, `expected at least 4 attempts, got ${n}`);
  } finally {
    global.setTimeout = orig;
  }
});

test('callWithRetry: does not retry on non-retryable error', async () => {
  const { callWithRetry } = skillEvalLive._internal;
  let n = 0;
  const impl = async () => { n += 1; throw new Error('400 bad request'); };
  const res = await callWithRetry({ backendImpl: impl, backendArgs: {}, timeoutMs: 5000 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(n, 1);
});

test('runWithTimeout: times out long-running calls', async () => {
  const { runWithTimeout } = skillEvalLive._internal;
  let threw = false;
  try {
    await runWithTimeout(() => new Promise((resolve) => setTimeout(resolve, 100)), 20);
  } catch (err) {
    threw = true;
    assert.match(String(err.message), /^timeout:/);
  }
  assert.strictEqual(threw, true);
});

test('isRetryableError: classifies correctly', () => {
  const { isRetryableError } = skillEvalLive._internal;
  assert.strictEqual(isRetryableError(new Error('429 too many requests')), true);
  assert.strictEqual(isRetryableError(new Error('500 internal server error')), true);
  assert.strictEqual(isRetryableError(new Error('endpoint unreachable (ECONNREFUSED): https://x')), true);
  assert.strictEqual(isRetryableError(new Error('400 bad request')), false);
  assert.strictEqual(isRetryableError(new Error('timeout:60000ms')), false);
});

// ----------------------------------------------------------------------------
// End-to-end score() test with fake backend + a small synthetic skill workspace.
// ----------------------------------------------------------------------------

function makeSyntheticSkill(rootDir, skillId, evalsObj) {
  const skillDir = path.join(rootDir, 'skills', skillId);
  fs.mkdirSync(path.join(skillDir, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillId}\ndescription: synthetic test skill for grading-category tests\n---\n\n# ${skillId}\n\nSynthetic content for assertion scoring.\n`);
  fs.writeFileSync(path.join(skillDir, 'evals', 'evals.json'), JSON.stringify(evalsObj, null, 2));
}

test('score: end-to-end with fake backend, mixed assertion shapes', async () => {
  // We can't easily move SKILLS_DIR per-test (it's a const). Instead we use a
  // skill name that exists in the real skills/ tree and inject the backend
  // impl so no real call happens. Pick a skill we know has evals.
  const result = await skillEvalLive.score({
    skill: 'cro',
    noCache: true,
    callBackendImpl: makeFakeImpl(async ({ userPrompt }) => {
      // Return an output stuffed with the assertion tokens so most-but-not-all assertions pass.
      const output = [
        'modern.attribution.first_touch grouped by landing_page',
        'modern.sales.aov segmented by traffic_source and device',
        '5-second value-prop test on mobile and desktop',
        'PDP friction taxonomy: images, variant selector, trust signals',
        'mobile vs desktop conversion split',
        '.agents/modern-ai-context.md present',
        'Quick Wins, High-Impact Changes, Test Ideas',
        'single highest-leverage next move',
        'sticky-bottom add-to-cart, Apple Pay, Google Pay, tap path',
        'subscribe-and-save, primary CTA, subordinate the rest',
        'subscription-vs-one-time mix',
        'message-match, campaign-specific landing page, H1 echo, ad-creative pairing, programmatic-seo',
        'redesign-vs-control holdout, sample-size discipline, ab-testing isolation, value-prop, trust signal',
        'rewrite H1 lead with category outcome trust signal, copywriting headline framing',
        'rewrite H1, category, outcome, trust signal, worked example',
        '3x gap mobile-first CRO framework',
        userPrompt.slice(0, 60),
      ].join('. ');
      return { output, usage: { input_tokens: 100, output_tokens: 200 } };
    }),
  });

  assert.ok(typeof result.score === 'number', `expected numeric score, got ${result.score}`);
  assert.ok(result.score >= 0 && result.score <= 100, `score out of range: ${result.score}`);
  assert.ok(result.detail.totalCases > 0, 'should have run at least one case');
  assert.strictEqual(result.detail.modelUsed, skillEvalLive._internal.DEFAULT_MODEL);
  assert.ok(Array.isArray(result.detail.perSkill));
  const cro = result.detail.perSkill.find((s) => s.skillId === 'cro');
  assert.ok(cro, 'cro should appear in perSkill');
  assert.ok(cro.totalCases >= 5);
});

test('score: returns null when no anthropic credential and no fake backend', async () => {
  // Strip env vars temporarily.
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedAlias = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedFake = process.env.OPENCLAW_GRADE_FAKE_BACKEND;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENCLAW_GRADE_FAKE_BACKEND;
  try {
    const result = await skillEvalLive.score({ skill: 'cro', noCache: true });
    assert.strictEqual(result.score, null);
    assert.match(String(result.detail), /no-anthropic-credential/);
  } finally {
    if (savedOauth) process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedAlias) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedAlias;
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedFake) process.env.OPENCLAW_GRADE_FAKE_BACKEND = savedFake;
  }
});

test('score: writes and reads cache (within 30 day window)', async () => {
  // Use a temp cache by intercepting writes via CACHE_PATH.
  const cachePath = skillEvalLive._internal.CACHE_PATH;
  const backupExists = fs.existsSync(cachePath);
  let backup = null;
  if (backupExists) backup = fs.readFileSync(cachePath, 'utf8');
  if (backupExists) fs.unlinkSync(cachePath);

  let callCount = 0;
  const fakeImpl = makeFakeImpl(async () => {
    callCount += 1;
    return {
      output: 'this output happens to contain attribution, landing_page, traffic_source, device, mobile, friction, trust, signal, quick, wins, impact, changes, test, ideas, highest, leverage, redesign, holdout, message, match, sticky, bottom, apple, pay, google, subscribe, save, primary, cta, rewrite, headline, copywriting, value, prop, framework, single, page, ab-testing, programmatic, seo, ad-creative.',
      usage: { input_tokens: 50, output_tokens: 100 },
    };
  });

  try {
    // First run - populates cache.
    const r1 = await skillEvalLive.score({ skill: 'cro', callBackendImpl: fakeImpl });
    const firstCalls = callCount;
    assert.ok(firstCalls > 0, 'first run should make calls');
    assert.ok(fs.existsSync(cachePath), 'cache file should exist after first run');

    // Second run - all served from cache.
    callCount = 0;
    const r2 = await skillEvalLive.score({ skill: 'cro', callBackendImpl: fakeImpl });
    assert.strictEqual(callCount, 0, 'second run should hit cache for every case');
    assert.strictEqual(r1.detail.totalCases, r2.detail.totalCases);
    assert.strictEqual(r2.detail.cacheHits, r2.detail.totalCases);
  } finally {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (backup) fs.writeFileSync(cachePath, backup);
  }
});

test('score: --cache-only marks cache misses as skipped', async () => {
  const cachePath = skillEvalLive._internal.CACHE_PATH;
  const backupExists = fs.existsSync(cachePath);
  let backup = null;
  if (backupExists) { backup = fs.readFileSync(cachePath, 'utf8'); fs.unlinkSync(cachePath); }

  try {
    let calls = 0;
    const impl = makeFakeImpl(async () => { calls += 1; return { output: 'never reached', usage: { input_tokens: 1, output_tokens: 1 } }; });
    const r = await skillEvalLive.score({ skill: 'cro', cacheOnly: true, callBackendImpl: impl });
    assert.strictEqual(calls, 0, 'cache-only must not invoke the backend on cache miss');
    // Every case was a miss so every case was skipped.
    assert.ok(r.detail.skipped > 0, 'should have skipped cases');
  } finally {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (backup) fs.writeFileSync(cachePath, backup);
  }
});

test('score: timeout marks case as failed', async () => {
  const slowImpl = makeFakeImpl(() => new Promise((resolve) => setTimeout(resolve, 500)));
  const r = await skillEvalLive.score({
    skill: 'cro',
    noCache: true,
    timeoutMs: 25,
    callBackendImpl: slowImpl,
  });
  assert.ok(r.detail.timedOut >= 1, `expected at least one timeout, got ${r.detail.timedOut}`);
  assert.ok(r.detail.failed >= 1);
});

// ----------------------------------------------------------------------------
// Triggering-accuracy tests.
// ----------------------------------------------------------------------------

test('extractDescription: pulls single-line description from frontmatter', () => {
  const md = ['---', 'name: foo', 'description: This is the description.', 'metadata:', '  v: 1', '---', '', '# foo'].join('\n');
  const d = triggering._internal.extractDescription(md);
  assert.strictEqual(d, 'This is the description.');
});

test('extractDescription: handles multi-line description', () => {
  const md = ['---', 'name: foo', 'description: first line', '  second line continuation', '  third line continuation', 'metadata:', '  v: 1', '---'].join('\n');
  const d = triggering._internal.extractDescription(md);
  assert.match(d, /first line/);
  assert.match(d, /second line/);
  assert.match(d, /third line/);
});

test('normalizePick: parses common model outputs', () => {
  const catalog = [{ skillId: 'cro', description: '' }, { skillId: 'incident-response', description: '' }];
  assert.strictEqual(triggering._internal.normalizePick('cro', catalog), 'cro');
  assert.strictEqual(triggering._internal.normalizePick('  cro\n', catalog), 'cro');
  assert.strictEqual(triggering._internal.normalizePick('`cro`', catalog), 'cro');
  assert.strictEqual(triggering._internal.normalizePick('cro.', catalog), 'cro');
  assert.strictEqual(triggering._internal.normalizePick('"incident-response"', catalog), 'incident-response');
  assert.strictEqual(triggering._internal.normalizePick('none', catalog), 'none');
  assert.strictEqual(triggering._internal.normalizePick('I would pick the cro skill', catalog), 'cro');
});

test('expectedPickMatches: single expected and array (ambiguous)', () => {
  const single = { expectedSkill: 'cro' };
  const ambig = { expectedSkills: ['cro', 'ab-testing'] };
  const none = { expectedSkill: 'none' };
  assert.strictEqual(triggering._internal.expectedPickMatches('cro', single), true);
  assert.strictEqual(triggering._internal.expectedPickMatches('ab-testing', single), false);
  assert.strictEqual(triggering._internal.expectedPickMatches('cro', ambig), true);
  assert.strictEqual(triggering._internal.expectedPickMatches('ab-testing', ambig), true);
  assert.strictEqual(triggering._internal.expectedPickMatches('copywriting', ambig), false);
  assert.strictEqual(triggering._internal.expectedPickMatches('none', none), true);
  assert.strictEqual(triggering._internal.expectedPickMatches('cro', none), false);
});

test('triggering.score: end-to-end with deterministic fake backend', async () => {
  // Fake backend that picks the right skill for the first few cases and "none" for the rest.
  const cachePath = triggering._internal.CACHE_PATH;
  const backupExists = fs.existsSync(cachePath);
  let backup = null;
  if (backupExists) { backup = fs.readFileSync(cachePath, 'utf8'); fs.unlinkSync(cachePath); }
  try {
    const impl = makeFakeImpl(async ({ userPrompt }) => {
      // The userPrompt embeds the user request; we sniff for tokens.
      const lower = userPrompt.toLowerCase();
      let pick = 'none';
      if (/post-mortem/.test(lower)) pick = 'post-mortem-writing';
      else if (/sev 1/.test(lower)) pick = 'incident-response';
      else if (/converting at 1\.2/.test(lower)) pick = 'cro';
      else if (/a\/b test/.test(lower) || /sample size/.test(lower)) pick = 'ab-testing';
      else if (/abandonment/.test(lower)) pick = 'cart-abandonment-recovery';
      else if (/runbook/.test(lower)) pick = 'runbook-writing';
      else if (/slo /.test(lower)) pick = 'slo-design';
      else if (/feature flag/.test(lower)) pick = 'feature-flagging';
      else if (/load test/.test(lower)) pick = 'load-testing';
      else if (/threat[- ]model/.test(lower)) pick = 'threat-modeling';
      else if (/winback/.test(lower)) pick = 'winback-flows';
      else if (/subscription churn/.test(lower)) pick = 'subscription-churn';
      else if (/adr/.test(lower)) pick = 'architecture-decision-records';
      else if (/credential/.test(lower) || /secrets/.test(lower)) pick = 'secrets-management';
      else if (/seo audit/.test(lower)) pick = 'seo-audit';
      else if (/schema markup/.test(lower) || /rich results/.test(lower)) pick = 'schema-markup';
      else if (/positioning/.test(lower)) pick = 'product-marketing-positioning';
      else if (/tokyo/.test(lower) || /haiku/.test(lower) || /vacation/.test(lower)) pick = 'none';
      return { output: pick, usage: { input_tokens: 80, output_tokens: 5 } };
    });
    const r = await triggering.score({ noCache: true, callBackendImpl: impl });
    assert.ok(typeof r.score === 'number', `expected numeric score, got ${r.score}`);
    assert.ok(r.detail.totalCases >= 30, `expected at least 30 cases, got ${r.detail.totalCases}`);
    assert.ok(r.detail.correct > 0, 'should have some correct picks');
    assert.ok(r.detail.distribution['clear-match'] > 0);
    assert.ok(r.detail.distribution['no-match'] > 0);
    assert.ok(r.detail.distribution.ambiguous > 0);
  } finally {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (backup) fs.writeFileSync(cachePath, backup);
  }
});

// ----------------------------------------------------------------------------
// Trigger-cases fixture sanity.
// ----------------------------------------------------------------------------

test('trigger-cases fixture: schema, distribution, no PII patterns', () => {
  const cases = triggering._internal.loadCases();
  assert.ok(cases.length >= 30, `expected at least 30 cases, got ${cases.length}`);
  assert.ok(cases.length <= 60, `expected at most 60 cases, got ${cases.length}`);
  const dist = {};
  for (const c of cases) {
    assert.ok(c.id, 'each case has an id');
    assert.ok(c.kind, `case ${c.id} missing kind`);
    assert.ok(c.request && c.request.length > 0, `case ${c.id} missing request`);
    if (c.kind === 'ambiguous') {
      assert.ok(Array.isArray(c.expectedSkills) && c.expectedSkills.length >= 2, `ambiguous case ${c.id} needs expectedSkills array`);
    } else {
      assert.ok(typeof c.expectedSkill === 'string' && c.expectedSkill.length > 0, `case ${c.id} needs expectedSkill string`);
    }
    dist[c.kind] = (dist[c.kind] || 0) + 1;
    // No PII patterns.
    assert.ok(!/@\w+\.(com|org|net|io|co)/.test(c.request), `case ${c.id} contains email-like PII`);
    assert.ok(!/\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(c.request), `case ${c.id} contains SSN-like PII`);
  }
  assert.ok(dist['clear-match'] >= 8);
  assert.ok(dist['oblique-match'] >= 6);
  assert.ok(dist['no-match'] >= 3);
  assert.ok(dist.ambiguous >= 3);
});

// ----------------------------------------------------------------------------
// Runner.
// ----------------------------------------------------------------------------

(async function main() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`ok  ${name}\n`);
    } catch (err) {
      fail += 1;
      failures.push({ name, err });
      process.stdout.write(`FAIL ${name}: ${err && err.message ? err.message : err}\n`);
    }
  }
  process.stdout.write(`\n${pass}/${TESTS.length} passed, ${fail} failed\n`);
  if (fail > 0) {
    for (const f of failures) {
      if (f.err && f.err.stack) process.stderr.write(`\n${f.name}:\n${f.err.stack}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
