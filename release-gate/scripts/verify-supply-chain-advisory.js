#!/usr/bin/env node
'use strict';

// Supply-chain advisory checker.
//
// Runs `npm audit --json` and `osv-scanner --lockfile=package-lock.json`,
// merges findings, applies the allowlist at release-gate/supply-chain-allowlist.json,
// then exits 0 only if every remaining HIGH/CRITICAL finding is covered by an
// unexpired allowlist entry.
//
// Test-mode environment variables (used by test-supply-chain-advisory.js):
//   OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE  Path to JSON file used instead of running `npm audit`.
//   OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE        Path to JSON file used instead of running `osv-scanner`.
//   OPENCLAW_SUPPLY_CHAIN_OSV_FORCE_MISSING  If '1', simulate `osv-scanner` not on PATH.
//   OPENCLAW_SUPPLY_CHAIN_ALLOWLIST          Path override for the allowlist JSON.
//   OPENCLAW_SUPPLY_CHAIN_NOW                ISO timestamp override for allowlist-expiry checks.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const SEVERITY_ORDER = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const HIGH_SEV = new Set(['high', 'critical']);

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function whichOsvScanner() {
  if (process.env.OPENCLAW_SUPPLY_CHAIN_OSV_FORCE_MISSING === '1') return null;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(probe, ['osv-scanner'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function runNpmAudit() {
  const fixture = process.env.OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE;
  if (fixture) return readJsonFile(fixture);
  let stdout = '';
  try {
    stdout = execFileSync('npm', ['audit', '--json'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // npm audit exits 1 when vulnerabilities exist; stdout still holds the report.
    stdout = err.stdout ? String(err.stdout) : '';
    if (!stdout) throw err;
  }
  return JSON.parse(stdout);
}

function runOsvScanner() {
  const fixture = process.env.OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE;
  if (fixture) return { installed: true, report: readJsonFile(fixture) };
  const binary = whichOsvScanner();
  if (!binary) return { installed: false, report: null };
  let stdout = '';
  try {
    stdout = execFileSync(
      binary,
      ['--lockfile=' + path.join(root, 'package-lock.json'), '--format=json', '--output=-'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    stdout = err.stdout ? String(err.stdout) : '';
    if (!stdout) return { installed: true, report: { results: [] }, runError: String(err.message || err) };
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (err) {
    return { installed: true, report: { results: [] }, parseError: String(err.message || err) };
  }
  return { installed: true, report: parsed };
}

function extractGhsaId(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return match ? match[0].toUpperCase() : null;
}

function normalizeNpmFindings(audit) {
  const out = [];
  const vulns = audit && audit.vulnerabilities ? audit.vulnerabilities : {};
  for (const [name, v] of Object.entries(vulns)) {
    if (!v || typeof v !== 'object') continue;
    const severity = String(v.severity || '').toLowerCase();
    const advisories = Array.isArray(v.via)
      ? v.via.filter((x) => x && typeof x === 'object').map((x) => {
        const ghsa = extractGhsaId(x.url) || extractGhsaId(x.title);
        return {
          id: ghsa || (x.source ? 'npm-' + x.source : (x.url || x.title || 'npm-advisory')),
          ghsa,
          title: x.title || x.name || 'advisory',
          url: x.url || null,
          severity: String(x.severity || severity).toLowerCase(),
        };
      })
      : [];
    out.push({
      source: 'npm-audit',
      package: name,
      severity,
      range: v.range || null,
      fixAvailable: v.fixAvailable || false,
      advisories,
    });
  }
  return out;
}

function normalizeOsvFindings(osv) {
  const out = [];
  const results = osv && Array.isArray(osv.results) ? osv.results : [];
  for (const result of results) {
    const packages = Array.isArray(result.packages) ? result.packages : [];
    for (const pkg of packages) {
      const pkgInfo = pkg.package || {};
      const vulns = Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : [];
      for (const vuln of vulns) {
        const dbSpecific = vuln.database_specific || {};
        const severity = String(dbSpecific.severity || vuln.severity || '').toLowerCase();
        out.push({
          source: 'osv-scanner',
          package: pkgInfo.name || null,
          version: pkgInfo.version || null,
          ecosystem: pkgInfo.ecosystem || null,
          id: vuln.id || null,
          severity,
          summary: vuln.summary || null,
          aliases: Array.isArray(vuln.aliases) ? vuln.aliases : [],
        });
      }
    }
  }
  return out;
}

function loadAllowlist() {
  const override = process.env.OPENCLAW_SUPPLY_CHAIN_ALLOWLIST;
  const file = override ? path.resolve(override) : path.join(root, 'release-gate', 'supply-chain-allowlist.json');
  if (!fs.existsSync(file)) return { schema: 'openclaw-frontier.supply-chain-allowlist.v1', entries: [] };
  const parsed = readJsonFile(file);
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { schema: 'openclaw-frontier.supply-chain-allowlist.v1', entries: [] };
  }
  return parsed;
}

function findingMatchesEntry(finding, entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.package && finding.package && entry.package !== finding.package) return false;
  if (entry.id) {
    const entryId = String(entry.id);
    const entryIdUpper = entryId.toUpperCase();
    if (finding.id && (entryId === finding.id || entryIdUpper === String(finding.id).toUpperCase())) return true;
    const advisories = Array.isArray(finding.advisories) ? finding.advisories : [];
    for (const adv of advisories) {
      if (!adv) continue;
      if (adv.id && (entryId === adv.id || entryIdUpper === String(adv.id).toUpperCase())) return true;
      if (adv.ghsa && entryIdUpper === String(adv.ghsa).toUpperCase()) return true;
    }
    const aliases = Array.isArray(finding.aliases) ? finding.aliases : [];
    for (const alias of aliases) {
      if (alias && entryIdUpper === String(alias).toUpperCase()) return true;
    }
    return false;
  }
  return Boolean(entry.package && entry.package === finding.package);
}

function applyAllowlist(findings, allowlist, now) {
  const applied = [];
  const remaining = [];
  for (const finding of findings) {
    if (!HIGH_SEV.has(finding.severity)) {
      remaining.push(finding);
      continue;
    }
    let matched = null;
    for (const entry of allowlist.entries) {
      if (!findingMatchesEntry(finding, entry)) continue;
      const expires = entry.expires ? Date.parse(entry.expires) : NaN;
      if (!Number.isFinite(expires)) continue;
      if (expires <= now) continue;
      matched = entry;
      break;
    }
    if (matched) {
      applied.push({
        finding: { source: finding.source, package: finding.package, id: finding.id || null, severity: finding.severity },
        entry: { id: matched.id, package: matched.package, reason: matched.reason, expires: matched.expires },
      });
      remaining.push({ ...finding, severity: 'info', originalSeverity: finding.severity, allowlisted: true });
    } else {
      remaining.push(finding);
    }
  }
  return { findings: remaining, allowlistApplied: applied };
}

function summarize(findings) {
  let high = 0;
  let critical = 0;
  for (const f of findings) {
    if (f.severity === 'high') high += 1;
    if (f.severity === 'critical') critical += 1;
  }
  return { high, critical };
}

function main() {
  const generatedAt = new Date().toISOString();
  const nowParsed = process.env.OPENCLAW_SUPPLY_CHAIN_NOW ? Date.parse(process.env.OPENCLAW_SUPPLY_CHAIN_NOW) : Date.parse(generatedAt);
  const now = Number.isFinite(nowParsed) ? nowParsed : Date.now();

  const npmRaw = runNpmAudit();
  const npmFindings = normalizeNpmFindings(npmRaw);

  const osvResult = runOsvScanner();
  const osvFindings = osvResult.installed && osvResult.report ? normalizeOsvFindings(osvResult.report) : [];
  const infoFindings = [];
  if (!osvResult.installed) {
    infoFindings.push({
      source: 'tooling',
      id: 'osv-scanner-not-installed',
      severity: 'info',
      summary: 'osv-scanner binary not on PATH; OSV scan skipped. Install from https://google.github.io/osv-scanner/ to enable.',
    });
  }
  if (osvResult.runError) {
    infoFindings.push({ source: 'tooling', id: 'osv-scanner-run-error', severity: 'info', summary: osvResult.runError });
  }
  if (osvResult.parseError) {
    infoFindings.push({ source: 'tooling', id: 'osv-scanner-parse-error', severity: 'info', summary: osvResult.parseError });
  }

  const allowlist = loadAllowlist();
  const npmApplied = applyAllowlist(npmFindings, allowlist, now);
  const osvApplied = applyAllowlist(osvFindings, allowlist, now);

  const npmSummary = summarize(npmApplied.findings);
  const osvSummary = summarize(osvApplied.findings);

  const blockingCount = npmSummary.high + npmSummary.critical + osvSummary.high + osvSummary.critical;
  const ok = blockingCount === 0;

  const report = {
    schema: 'openclaw-frontier.supply-chain-advisory.v1',
    ok,
    generatedAt,
    npmAudit: {
      high: npmSummary.high,
      critical: npmSummary.critical,
      findings: npmApplied.findings,
    },
    osvScan: {
      installed: osvResult.installed,
      high: osvSummary.high,
      critical: osvSummary.critical,
      findings: osvApplied.findings,
    },
    info: infoFindings,
    allowlistApplied: [...npmApplied.allowlistApplied, ...osvApplied.allowlistApplied],
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeNpmFindings,
  normalizeOsvFindings,
  applyAllowlist,
  findingMatchesEntry,
  summarize,
};
