'use strict';

/**
 * lib/doctor/checks.js — individual runtime health checks for `openclaw doctor`.
 *
 * Each exported function returns a check result with the shape:
 *   { name, ok, severity: 'info'|'warn'|'error', detail }
 *
 * `ok` is a strict pass/fail boolean. `severity` controls how `runDoctor`
 * aggregates the overall verdict: only checks that are both `ok: false` and
 * `severity: 'error'` cause the report to fail.
 *
 * Checks never throw. Every check captures its own runtime errors and reports
 * them as `{ ok: false, severity: 'error', detail: { reason, ... } }`.
 *
 * Sensitive material (env-resolved API tokens, private keys) must NEVER appear
 * in the returned `detail` payload. Only the SHAPE of the resolution is
 * reported (provider name, auth method, byte length where useful) — never the
 * value.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SEVERITY_ERROR = 'error';
const SEVERITY_WARN = 'warn';
const SEVERITY_INFO = 'info';

function buildResult(name, ok, severity, detail) {
  return { name, ok: Boolean(ok), severity, detail: detail || {} };
}

// ---------------------------------------------------------------------------
// 1. blackboardReachable: confirm the blackboard ledger path is writable by
// appending and removing a probe record.
// ---------------------------------------------------------------------------

function blackboardReachable(opts = {}) {
  const name = 'blackboardReachable';
  const ledgerPath = opts.blackboard
    || path.join(opts.repoRoot || process.cwd(), 'release-gate', 'blackboard.jsonl');
  try {
    const dir = path.dirname(ledgerPath);
    fs.mkdirSync(dir, { recursive: true });
    const beforeSize = fs.existsSync(ledgerPath)
      ? fs.statSync(ledgerPath).size
      : null;
    const probe = {
      schema: 'openclaw-frontier.doctor-probe.v1',
      ts: new Date().toISOString(),
      nonce: crypto.randomBytes(8).toString('hex'),
    };
    const probeLine = JSON.stringify(probe) + '\n';
    fs.appendFileSync(ledgerPath, probeLine, 'utf8');
    // Read back and verify the line landed.
    const afterSize = fs.statSync(ledgerPath).size;
    if (afterSize < (beforeSize || 0) + probeLine.length) {
      return buildResult(name, false, SEVERITY_ERROR, {
        ledgerPath,
        reason: 'probe append did not grow the ledger',
      });
    }
    // Remove the probe line so we leave no residue.
    const content = fs.readFileSync(ledgerPath, 'utf8');
    if (content.endsWith(probeLine)) {
      fs.writeFileSync(ledgerPath, content.slice(0, content.length - probeLine.length), 'utf8');
    }
    return buildResult(name, true, SEVERITY_INFO, {
      ledgerPath,
      writable: true,
    });
  } catch (err) {
    return buildResult(name, false, SEVERITY_ERROR, {
      ledgerPath,
      reason: 'ledger probe failed',
      message: String(err && err.message ? err.message : err),
    });
  }
}

// ---------------------------------------------------------------------------
// 2. signedBusKeysPresent: confirm a signed-bus identity key is configured and
// it looks like an Ed25519 key (~32 bytes after PEM or OpenSSH decode).
// Reports presence only — never the key bytes themselves.
// ---------------------------------------------------------------------------

function signedBusKeysPresent(opts = {}) {
  const name = 'signedBusKeysPresent';
  const keyPath = opts.identityKey
    || process.env.OPENCLAW_IDENTITY_KEY
    || null;
  if (!keyPath) {
    return buildResult(name, true, SEVERITY_INFO, {
      configured: false,
      note: 'no signed-bus identity key configured; signing is optional',
    });
  }
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    return buildResult(name, false, SEVERITY_ERROR, {
      configured: true,
      exists: false,
      reason: 'identity key path does not exist',
    });
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8').trim();
    const looksPem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
    const looksOpenSsh = raw.startsWith('ssh-ed25519 ');
    if (!looksPem && !looksOpenSsh) {
      return buildResult(name, false, SEVERITY_ERROR, {
        configured: true,
        exists: true,
        reason: 'key does not look like PEM or OpenSSH ed25519',
      });
    }
    if (looksPem) {
      // Validate that crypto can parse the key and that it claims Ed25519.
      const keyObject = crypto.createPrivateKey({ key: raw, format: 'pem' });
      const type = keyObject.asymmetricKeyType || '';
      if (type !== 'ed25519') {
        return buildResult(name, false, SEVERITY_ERROR, {
          configured: true,
          exists: true,
          reason: 'PEM key is not Ed25519',
          asymmetricKeyType: type || 'unknown',
        });
      }
      return buildResult(name, true, SEVERITY_INFO, {
        configured: true,
        exists: true,
        format: 'pem',
        asymmetricKeyType: 'ed25519',
      });
    }
    // OpenSSH wire format: ssh-ed25519 <base64-blob> <comment>
    const parts = raw.split(/\s+/);
    const blob = Buffer.from(parts[1] || '', 'base64');
    if (blob.length < 36) {
      return buildResult(name, false, SEVERITY_ERROR, {
        configured: true,
        exists: true,
        reason: 'OpenSSH blob too short for ed25519',
      });
    }
    const algoLen = blob.readUInt32BE(0);
    const keyOffset = 4 + algoLen;
    const keyLen = blob.readUInt32BE(keyOffset);
    if (keyLen !== 32) {
      return buildResult(name, false, SEVERITY_ERROR, {
        configured: true,
        exists: true,
        reason: 'OpenSSH key payload is not 32 bytes',
        keyLen,
      });
    }
    return buildResult(name, true, SEVERITY_INFO, {
      configured: true,
      exists: true,
      format: 'openssh',
      asymmetricKeyType: 'ed25519',
    });
  } catch (err) {
    return buildResult(name, false, SEVERITY_ERROR, {
      configured: true,
      exists: true,
      reason: 'could not parse identity key',
      message: String(err && err.message ? err.message : err),
    });
  }
}

// ---------------------------------------------------------------------------
// 3. roleContractsPresent: walk `agents/*/CONTRACT.md` and confirm each role
// has a contract. The set of roles is read from the agents/ directory itself
// because coordination patterns accept arbitrary role names from callers.
// ---------------------------------------------------------------------------

function roleContractsPresent(opts = {}) {
  const name = 'roleContractsPresent';
  const repoRoot = opts.repoRoot || process.cwd();
  const agentsDir = opts.agentsDir || path.join(repoRoot, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return buildResult(name, false, SEVERITY_ERROR, {
      reason: 'agents directory not found',
      agentsDir,
    });
  }
  let entries;
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    return buildResult(name, false, SEVERITY_ERROR, {
      reason: 'could not read agents directory',
      message: String(err && err.message ? err.message : err),
    });
  }
  const roles = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const missing = [];
  for (const role of roles) {
    const contractPath = path.join(agentsDir, role, 'CONTRACT.md');
    if (!fs.existsSync(contractPath)) missing.push(role);
  }
  if (missing.length > 0) {
    return buildResult(name, false, SEVERITY_ERROR, {
      reason: 'one or more roles lack a CONTRACT.md',
      missing,
      rolesChecked: roles.length,
    });
  }
  return buildResult(name, true, SEVERITY_INFO, {
    rolesChecked: roles.length,
    roles,
  });
}

// ---------------------------------------------------------------------------
// 4. modelBackendConfigured: report which auth env var is set without leaking
// the value. Resolution order: ANTHROPIC_OAUTH_TOKEN > ANTHROPIC_API_KEY >
// OPENCLAW_EVAL_API_KEY > OPENAI_API_KEY.
// ---------------------------------------------------------------------------

function modelBackendConfigured(opts = {}) {
  const name = 'modelBackendConfigured';
  const env = opts.env || process.env;
  // Order matters; the first non-empty wins.
  const order = [
    { var: 'ANTHROPIC_OAUTH_TOKEN', provider: 'anthropic', authMethod: 'oauth' },
    { var: 'ANTHROPIC_API_KEY', provider: 'anthropic', authMethod: 'api-key' },
    { var: 'OPENCLAW_EVAL_API_KEY', provider: 'openai-compatible', authMethod: 'api-key' },
    { var: 'OPENAI_API_KEY', provider: 'openai', authMethod: 'api-key' },
  ];
  for (const entry of order) {
    const raw = env[entry.var];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return buildResult(name, true, SEVERITY_INFO, {
        provider: entry.provider,
        authMethod: entry.authMethod,
        envVar: entry.var,
      });
    }
  }
  return buildResult(name, false, SEVERITY_WARN, {
    reason: 'no model backend credentials in env',
    checked: order.map((o) => o.var),
  });
}

// ---------------------------------------------------------------------------
// 5. modelBackendReachable: best-effort HEAD probe of the resolved backend
// URL. Skipped under --no-network. Treats any HTTP response (including 4xx)
// as "reachable" because the host is alive. Network errors are reported but
// only at WARN severity.
// ---------------------------------------------------------------------------

async function modelBackendReachable(opts = {}) {
  const name = 'modelBackendReachable';
  if (opts.noNetwork) {
    return buildResult(name, true, SEVERITY_INFO, {
      skipped: true,
      reason: '--no-network',
    });
  }
  const env = opts.env || process.env;
  let backendUrl = opts.endpoint || env.OPENCLAW_BACKEND_URL || null;
  if (!backendUrl) {
    if (env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) {
      backendUrl = 'https://api.anthropic.com';
    } else if (env.OPENAI_API_KEY || env.OPENCLAW_EVAL_API_KEY) {
      backendUrl = 'https://api.openai.com';
    } else {
      return buildResult(name, true, SEVERITY_INFO, {
        skipped: true,
        reason: 'no backend configured to probe',
      });
    }
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    try {
      const res = await fetch(backendUrl, { method: 'HEAD', signal: controller.signal });
      status = res.status;
    } finally {
      clearTimeout(timer);
    }
    return buildResult(name, true, SEVERITY_INFO, {
      backendUrl,
      httpStatus: status,
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return buildResult(name, false, SEVERITY_WARN, {
      backendUrl,
      reason: aborted ? `timed out after ${timeoutMs}ms` : 'network error',
      message: String(err && err.message ? err.message : err),
    });
  }
}

// ---------------------------------------------------------------------------
// 6. nodeVersionOk: confirm Node.js >= 20.
// ---------------------------------------------------------------------------

function nodeVersionOk(opts = {}) {
  const name = 'nodeVersionOk';
  const versionString = opts.nodeVersion || process.versions.node;
  const major = Number.parseInt(String(versionString).split('.')[0], 10);
  const required = 20;
  if (!Number.isFinite(major) || major < required) {
    return buildResult(name, false, SEVERITY_ERROR, {
      reason: `node ${required}+ required`,
      node: versionString,
    });
  }
  return buildResult(name, true, SEVERITY_INFO, {
    node: versionString,
    major,
    required,
  });
}

// ---------------------------------------------------------------------------
// 7. verifierLatest: report ok-status + timestamp of the most recent
// verifier run if a report file is on disk.
// ---------------------------------------------------------------------------

function verifierLatest(opts = {}) {
  const name = 'verifierLatest';
  const repoRoot = opts.repoRoot || process.cwd();
  const reportPath = opts.verifierReportPath
    || path.join(repoRoot, 'release-gate', 'reports', 'latest-verification.json');
  if (!fs.existsSync(reportPath)) {
    return buildResult(name, true, SEVERITY_INFO, {
      present: false,
      note: 'no prior verifier report; run npm run verify',
    });
  }
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    const report = JSON.parse(raw);
    const ok = Boolean(report.ok);
    return buildResult(name, ok, ok ? SEVERITY_INFO : SEVERITY_WARN, {
      present: true,
      verifierOk: ok,
      generatedAt: report.generatedAt || null,
      checkCount: Array.isArray(report.checks) ? report.checks.length : 0,
    });
  } catch (err) {
    return buildResult(name, false, SEVERITY_WARN, {
      present: true,
      reason: 'verifier report unreadable',
      message: String(err && err.message ? err.message : err),
    });
  }
}

// ---------------------------------------------------------------------------
// 8. ticketStoreOk: open the ticket store and count open tickets. Soft-fails
// (WARN) if the store can't be opened, because tickets are optional state.
// ---------------------------------------------------------------------------

function ticketStoreOk(opts = {}) {
  const name = 'ticketStoreOk';
  const repoRoot = opts.repoRoot || process.cwd();
  const ticketsPath = opts.ticketsPath
    || path.join(repoRoot, 'release-gate', 'tickets.jsonl');
  // Lazy-require so a missing tickets module never breaks the check.
  let createTicketStore;
  try {
    ({ createTicketStore } = require(path.join(
      repoRoot, 'src', 'tickets', 'lib', 'ticket-store.js',
    )));
  } catch (err) {
    return buildResult(name, false, SEVERITY_WARN, {
      reason: 'ticket-store module unavailable',
      message: String(err && err.message ? err.message : err),
    });
  }
  try {
    const store = createTicketStore({ ticketsPath });
    const items = store.list({});
    const counts = { open: 0, 'in-progress': 0, review: 0, done: 0, archived: 0 };
    for (const t of items) {
      if (counts[t.state] != null) counts[t.state] += 1;
    }
    const openish = counts.open + counts['in-progress'] + counts.review;
    return buildResult(name, true, SEVERITY_INFO, {
      ticketsPath,
      total: items.length,
      counts,
      openish,
    });
  } catch (err) {
    return buildResult(name, false, SEVERITY_WARN, {
      ticketsPath,
      reason: 'could not enumerate tickets',
      message: String(err && err.message ? err.message : err),
    });
  }
}

module.exports = {
  blackboardReachable,
  signedBusKeysPresent,
  roleContractsPresent,
  modelBackendConfigured,
  modelBackendReachable,
  nodeVersionOk,
  verifierLatest,
  ticketStoreOk,
  SEVERITY_ERROR,
  SEVERITY_WARN,
  SEVERITY_INFO,
};
