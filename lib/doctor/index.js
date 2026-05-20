'use strict';

/**
 * lib/doctor/index.js — `openclaw doctor` runtime health check.
 *
 * Distinct from `npm run verify`: that script is a build-time package-
 * correctness gate. `doctor` is a runtime probe that inspects the live
 * environment — blackboard reachability, signed-bus key presence, role
 * contracts on disk, model backend connectivity, and so on.
 *
 * Public API:
 *
 *   runDoctor(opts) -> Promise<{
 *     schema: 'openclaw-frontier.doctor-report.v1',
 *     ok: boolean,
 *     generatedAt: ISO,
 *     options: { repoRoot, blackboard, noNetwork, ... },
 *     checks: [{ name, ok, severity, detail }],
 *     summary: { total, passed, failed, byseverity: { error, warn, info } },
 *   }>
 *
 * Aggregation rule: `report.ok` is `true` only when no check in the report has
 * `{ ok: false, severity: 'error' }`. Checks with `severity: 'warn'` and
 * `severity: 'info'` never block the verdict — they're surfaced for the
 * operator but do not fail the run.
 *
 * Every check function in `checks.js` returns the same shape. Some checks are
 * async; runDoctor awaits all of them in document order.
 */

const checks = require('./checks.js');

const SCHEMA = 'openclaw-frontier.doctor-report.v1';

const CHECK_ORDER = [
  { fn: checks.nodeVersionOk, async: false },
  { fn: checks.roleContractsPresent, async: false },
  { fn: checks.blackboardReachable, async: false },
  { fn: checks.signedBusKeysPresent, async: false },
  { fn: checks.modelBackendConfigured, async: false },
  { fn: checks.modelBackendReachable, async: true },
  { fn: checks.verifierLatest, async: false },
  { fn: checks.ticketStoreOk, async: false },
];

function aggregateOk(results) {
  for (const r of results) {
    if (r.ok === false && r.severity === checks.SEVERITY_ERROR) return false;
  }
  return true;
}

function summarize(results) {
  const bySeverity = { error: 0, warn: 0, info: 0 };
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) passed += 1;
    else failed += 1;
    if (bySeverity[r.severity] != null) bySeverity[r.severity] += 1;
  }
  return {
    total: results.length,
    passed,
    failed,
    bySeverity,
  };
}

async function runDoctor(opts = {}) {
  const options = {
    repoRoot: opts.repoRoot || process.cwd(),
    blackboard: opts.blackboard || null,
    identityKey: opts.identityKey || null,
    noNetwork: Boolean(opts.noNetwork),
    endpoint: opts.endpoint || null,
    timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000,
    ticketsPath: opts.ticketsPath || null,
    agentsDir: opts.agentsDir || null,
    verifierReportPath: opts.verifierReportPath || null,
    env: opts.env || process.env,
    nodeVersion: opts.nodeVersion || null,
  };

  const results = [];
  for (const entry of CHECK_ORDER) {
    let result;
    try {
      const out = entry.fn(options);
      result = entry.async ? await out : out;
    } catch (err) {
      result = {
        name: entry.fn.name || 'unknown',
        ok: false,
        severity: checks.SEVERITY_ERROR,
        detail: {
          reason: 'check threw unexpectedly',
          message: String(err && err.message ? err.message : err),
        },
      };
    }
    if (!result || typeof result !== 'object') {
      result = {
        name: entry.fn.name || 'unknown',
        ok: false,
        severity: checks.SEVERITY_ERROR,
        detail: { reason: 'check returned non-object' },
      };
    }
    results.push(result);
  }

  return {
    schema: SCHEMA,
    ok: aggregateOk(results),
    generatedAt: new Date().toISOString(),
    options: {
      repoRoot: options.repoRoot,
      blackboard: options.blackboard,
      noNetwork: options.noNetwork,
      endpoint: options.endpoint,
    },
    checks: results,
    summary: summarize(results),
  };
}

function formatHumanReadable(report) {
  const lines = [];
  lines.push(`openclaw doctor: ${report.ok ? 'OK' : 'FAIL'}`);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`checks: ${report.summary.total} (${report.summary.passed} passed, ${report.summary.failed} failed)`);
  lines.push('');
  for (const c of report.checks) {
    const status = c.ok ? 'ok  ' : 'FAIL';
    const sev = (c.severity || 'info').toUpperCase().padEnd(5);
    const detailStr = formatDetail(c.detail);
    lines.push(`  [${status}] ${sev} ${c.name}: ${detailStr}`);
  }
  return lines.join('\n');
}

function formatDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const keys = Object.keys(detail);
  if (keys.length === 0) return '(no detail)';
  const pairs = [];
  for (const k of keys) {
    const v = detail[k];
    if (v == null) continue;
    let display;
    if (Array.isArray(v)) display = v.length <= 5 ? v.join(',') : `${v.slice(0, 5).join(',')}+${v.length - 5}`;
    else if (typeof v === 'object') display = JSON.stringify(v);
    else display = String(v);
    pairs.push(`${k}=${display}`);
  }
  return pairs.join(' ');
}

module.exports = {
  SCHEMA,
  runDoctor,
  formatHumanReadable,
  CHECK_ORDER,
};
