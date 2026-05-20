'use strict';

/**
 * lib/hooks/consent.js — explicit allowlist for executable hooks.
 *
 * The reference-runtime event-hook lifecycle lets operators bind arbitrary
 * executables to orchestration events. To prevent a malicious or
 * accidentally-introduced binary from running, every hook executable must
 * appear in `release-gate/hook-allowlist.json` together with a SHA-256 of
 * the exact bytes of the executable. Adding an entry requires the explicit
 * `openclaw hook allow <hookId>` action — the dispatcher never auto-adds.
 *
 * Replacing the executable on disk (even with another version of the same
 * file) invalidates the allowlist entry, because the SHA-256 will no longer
 * match. The operator must re-run `openclaw hook allow <hookId>` to consent
 * to the new bytes. This is the safety property the consent module enforces.
 *
 * The allowlist file is intentionally kept in-repo (under release-gate/) so
 * code review and CI can audit consent changes. It is NOT located under
 * $HOME so it survives `git clone` and is reproducible across operators.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALLOWLIST_SCHEMA = 'openclaw-frontier.hook-allowlist.v1';

class HookConsentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HookConsentError';
    this.code = 'HOOK_CONSENT';
    this.details = details;
  }
}

/**
 * Compute the SHA-256 hex digest of the bytes of a file.
 *
 * `crypto.createHash('sha256').update(buffer).digest('hex')` — the
 * canonical Node form. We read the whole file at once; hook executables
 * are small scripts in practice and we want the call to be synchronous so
 * the CLI can give a deterministic response when the operator runs
 * `openclaw hook allow`.
 */
function sha256OfFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new HookConsentError(`executable not found: ${filePath}`, { filePath: absolute });
  }
  const buf = fs.readFileSync(absolute);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Validate the shape of an allowlist record. The shape is intentionally
 * narrow so a typo or partial write produces a clear error rather than a
 * silent allow.
 */
function validateAllowlist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HookConsentError('allowlist must be an object');
  }
  if (value.schema !== ALLOWLIST_SCHEMA) {
    throw new HookConsentError(`allowlist.schema must be '${ALLOWLIST_SCHEMA}' (got: ${value.schema})`);
  }
  if (!Array.isArray(value.entries)) {
    throw new HookConsentError('allowlist.entries must be an array');
  }
  for (let i = 0; i < value.entries.length; i += 1) {
    const entry = value.entries[i];
    if (!entry || typeof entry !== 'object') {
      throw new HookConsentError(`allowlist.entries[${i}] must be an object`);
    }
    if (typeof entry.hookId !== 'string' || !entry.hookId.trim()) {
      throw new HookConsentError(`allowlist.entries[${i}].hookId must be a non-empty string`);
    }
    if (typeof entry.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.executableSha256)) {
      throw new HookConsentError(`allowlist.entries[${i}].executableSha256 must be a 64-char hex string`);
    }
    if (typeof entry.addedAt !== 'string' || !entry.addedAt) {
      throw new HookConsentError(`allowlist.entries[${i}].addedAt must be an ISO timestamp string`);
    }
  }
  return value;
}

/**
 * Read the allowlist from disk. If the file does not exist, return an
 * empty allowlist (no hooks allowed) — the dispatcher will then refuse to
 * spawn anything until the operator runs `openclaw hook allow`.
 */
function loadAllowlist(allowlistPath) {
  if (!allowlistPath) throw new HookConsentError('loadAllowlist: allowlistPath required');
  if (!fs.existsSync(allowlistPath)) {
    return { schema: ALLOWLIST_SCHEMA, entries: [] };
  }
  let raw;
  try {
    raw = fs.readFileSync(allowlistPath, 'utf8');
  } catch (err) {
    throw new HookConsentError(`cannot read allowlist: ${err.message}`, { allowlistPath });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HookConsentError(`allowlist is not valid JSON: ${err.message}`, { allowlistPath });
  }
  return validateAllowlist(parsed);
}

/**
 * Atomic write: write the new file to a sibling temp path then rename.
 * Allowlist mutations are infrequent (operator-driven) so we accept the
 * extra fsync cost for crash-safety.
 */
function saveAllowlist(allowlistPath, allowlist) {
  validateAllowlist(allowlist);
  const dir = path.dirname(allowlistPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${allowlistPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(allowlist, null, 2) + '\n');
  fs.renameSync(tmp, allowlistPath);
  return allowlistPath;
}

/**
 * Return true only when the (hookId, executableSha256) pair exists in the
 * allowlist. Exact match on both fields — no partial / case-insensitive
 * matching, no fuzzy lookup. This is the single chokepoint the dispatcher
 * consults before spawning anything.
 */
function isAllowed(allowlist, hookId, executablePath) {
  if (!allowlist || !Array.isArray(allowlist.entries)) return false;
  if (typeof hookId !== 'string' || !hookId) return false;
  let sha;
  try {
    sha = sha256OfFile(executablePath);
  } catch (_) {
    return false;
  }
  for (const entry of allowlist.entries) {
    if (entry.hookId === hookId && entry.executableSha256.toLowerCase() === sha.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Append (or replace) an entry for a hookId. The operator-facing
 * `openclaw hook allow` command calls this after computing the sha. We
 * collapse duplicate hookIds — only one entry per hookId is kept, and
 * re-allowing a hookId overwrites the previous sha. This is intentional:
 * the operator is explicitly consenting to the new bytes.
 */
function addEntry(allowlist, { hookId, executableSha256, addedAt }) {
  if (!hookId || typeof hookId !== 'string') {
    throw new HookConsentError('addEntry: hookId must be a non-empty string');
  }
  if (!/^[0-9a-f]{64}$/i.test(executableSha256 || '')) {
    throw new HookConsentError('addEntry: executableSha256 must be a 64-char hex string');
  }
  const ts = addedAt || new Date().toISOString();
  const next = {
    schema: ALLOWLIST_SCHEMA,
    entries: (allowlist.entries || []).filter((e) => e.hookId !== hookId),
  };
  next.entries.push({ hookId, executableSha256: executableSha256.toLowerCase(), addedAt: ts });
  next.entries.sort((a, b) => (a.hookId < b.hookId ? -1 : a.hookId > b.hookId ? 1 : 0));
  return next;
}

/**
 * Remove every entry matching hookId. Returns the updated allowlist (the
 * old one is not mutated). If no entry matches, returns the allowlist
 * unchanged.
 */
function removeEntry(allowlist, hookId) {
  if (!hookId || typeof hookId !== 'string') {
    throw new HookConsentError('removeEntry: hookId must be a non-empty string');
  }
  return {
    schema: ALLOWLIST_SCHEMA,
    entries: (allowlist.entries || []).filter((e) => e.hookId !== hookId),
  };
}

module.exports = {
  ALLOWLIST_SCHEMA,
  HookConsentError,
  loadAllowlist,
  saveAllowlist,
  isAllowed,
  addEntry,
  removeEntry,
  sha256OfFile,
  validateAllowlist,
};
