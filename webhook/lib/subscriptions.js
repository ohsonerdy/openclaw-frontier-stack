'use strict';

/**
 * webhook/lib/subscriptions.js — pure subscription loader & matcher.
 *
 * Subscriptions are loaded from a JSON file and validated up front. The
 * loader rejects shapes it does not recognise so a bad config fails fast
 * at daemon startup rather than at request time.
 *
 * Subscription shape:
 *   {
 *     id: string,                       unique identifier for logs/audit
 *     path: string,                     URL path the daemon listens on
 *     eventType: string | '*',          matched against X-GitHub-Event or
 *                                       a configurable header for generic
 *     secretEnv: string,                name of env var holding the secret
 *     role: string,                     blackboard role to dispatch to
 *     subject: string,                  subject prefix for the task-claim
 *     bodyTransform: string,            key into transforms map
 *     signatureHeader?: string,         override (default X-Hub-Signature-256)
 *     signatureAlgo?: 'sha256' | 'sha1' default 'sha256'
 *     eventHeader?: string,             override (default X-GitHub-Event)
 *   }
 */

const fs = require('fs');
const path = require('path');
const { transforms } = require('./transforms');

const ALLOWED_TRANSFORMS = new Set(Object.keys(transforms));
const ALLOWED_ALGOS = new Set(['sha256', 'sha1']);

class SubscriptionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SubscriptionError';
    this.details = details;
  }
}

function loadSubscriptions(filePath) {
  const resolved = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new SubscriptionError(`cannot read subscriptions file: ${err.code || err.message}`, { path: resolved });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SubscriptionError(`subscriptions file is not valid JSON: ${err.message}`, { path: resolved });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.subscriptions)) {
    throw new SubscriptionError('subscriptions file must contain { "subscriptions": [...] }', { path: resolved });
  }
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < parsed.subscriptions.length; i += 1) {
    out.push(validateSubscription(parsed.subscriptions[i], i, seenIds));
  }
  return out;
}

function validateSubscription(sub, index, seenIds) {
  if (!sub || typeof sub !== 'object') {
    throw new SubscriptionError(`subscription #${index} is not an object`);
  }
  const id = requireString(sub.id, `subscription[${index}].id`, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    throw new SubscriptionError(`subscription[${index}].id must be a simple identifier`);
  }
  if (seenIds.has(id)) {
    throw new SubscriptionError(`subscription id repeated: ${id}`);
  }
  seenIds.add(id);
  const subPath = requireString(sub.path, `subscription[${index}].path`, 200);
  if (!subPath.startsWith('/')) {
    throw new SubscriptionError(`subscription[${index}].path must start with /`);
  }
  if (/[\s?#]/.test(subPath)) {
    throw new SubscriptionError(`subscription[${index}].path must not contain whitespace, query, or fragment`);
  }
  const eventType = requireString(sub.eventType, `subscription[${index}].eventType`, 64);
  const secretEnv = requireString(sub.secretEnv, `subscription[${index}].secretEnv`, 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(secretEnv)) {
    throw new SubscriptionError(`subscription[${index}].secretEnv must be an ALL_CAPS env-var name`);
  }
  const role = requireString(sub.role, `subscription[${index}].role`, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(role)) {
    throw new SubscriptionError(`subscription[${index}].role must be a simple role id`);
  }
  const subject = requireString(sub.subject, `subscription[${index}].subject`, 200);
  const bodyTransform = requireString(sub.bodyTransform, `subscription[${index}].bodyTransform`, 64);
  if (!ALLOWED_TRANSFORMS.has(bodyTransform)) {
    throw new SubscriptionError(`subscription[${index}].bodyTransform must be one of ${Array.from(ALLOWED_TRANSFORMS).join(',')}`);
  }
  const signatureAlgo = sub.signatureAlgo == null ? 'sha256' : requireString(sub.signatureAlgo, `subscription[${index}].signatureAlgo`, 16);
  if (!ALLOWED_ALGOS.has(signatureAlgo)) {
    throw new SubscriptionError(`subscription[${index}].signatureAlgo must be sha256 or sha1`);
  }
  const signatureHeader = sub.signatureHeader == null
    ? (signatureAlgo === 'sha256' ? 'x-hub-signature-256' : 'x-hub-signature')
    : requireString(sub.signatureHeader, `subscription[${index}].signatureHeader`, 64).toLowerCase();
  const eventHeader = sub.eventHeader == null
    ? 'x-github-event'
    : requireString(sub.eventHeader, `subscription[${index}].eventHeader`, 64).toLowerCase();
  return {
    id,
    path: subPath,
    eventType,
    secretEnv,
    role,
    subject,
    bodyTransform,
    signatureAlgo,
    signatureHeader,
    eventHeader,
  };
}

function requireString(value, field, max) {
  if (typeof value !== 'string') {
    throw new SubscriptionError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SubscriptionError(`${field} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new SubscriptionError(`${field} exceeds ${max} characters`);
  }
  return trimmed;
}

/**
 * Find the subscription whose path matches the request URL pathname and
 * whose eventType matches the request's event header (or '*' wildcard).
 * Returns null when no subscription applies.
 */
function matchSubscription(subscriptions, request) {
  if (!Array.isArray(subscriptions) || !request) return null;
  const pathname = parsePathname(request.url);
  if (pathname == null) return null;
  for (const sub of subscriptions) {
    if (sub.path !== pathname) continue;
    if (sub.eventType === '*') return sub;
    const headerValue = readHeader(request.headers, sub.eventHeader);
    if (typeof headerValue === 'string' && headerValue.toLowerCase() === sub.eventType.toLowerCase()) {
      return sub;
    }
  }
  return null;
}

function parsePathname(url) {
  if (typeof url !== 'string' || !url) return null;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  // Node's http.IncomingMessage lower-cases header names already, but the
  // pure module accepts either case for unit-test ergonomics.
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

module.exports = {
  loadSubscriptions,
  matchSubscription,
  SubscriptionError,
};
