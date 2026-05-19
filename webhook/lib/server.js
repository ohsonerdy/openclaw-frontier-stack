'use strict';

/**
 * webhook/lib/server.js — pure HTTP server factory for the openclaw-webhook
 * daemon.
 *
 * Exports `createServer(opts)` which returns an http.Server. The factory
 * does not call .listen() — the caller decides bind address and port.
 *
 * Request flow:
 *   1. Only POST is accepted; everything else returns 405.
 *   2. The request URL pathname plus the configured event header pick a
 *      subscription. No match → 404.
 *   3. The configured signature header is parsed and compared against
 *      HMAC(secret, raw-body) in constant time. Mismatch → 401.
 *   4. The body is JSON-decoded. Malformed JSON → 400.
 *   5. The body is run through the subscription's bodyTransform. Transform
 *      errors → 400.
 *   6. A task-claim record is appended to the blackboard via the ledger
 *      passed in via opts. A ledger failure → 500.
 *   7. On success the daemon responds 202 with an opaque audit id; the
 *      payload is never echoed back.
 *
 * Error responses are { ok: false, status, error } with `error` set to a
 * short category string. The raw payload is never reflected. The audit
 * logger is called for every response with a small fixed-shape record.
 */

const http = require('http');
const crypto = require('crypto');
const { matchSubscription } = require('./subscriptions');
const { transforms } = require('./transforms');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB hard cap on inbound payloads.
const TASK_ID_PREFIX = 'wh';

function createServer(opts) {
  const subscriptions = Array.isArray(opts && opts.subscriptions) ? opts.subscriptions : null;
  if (!subscriptions) throw new Error('createServer: opts.subscriptions is required');
  const ledger = opts.ledger;
  if (!ledger || typeof ledger.claimTask !== 'function') {
    throw new Error('createServer: opts.ledger must be a BlackboardLedger');
  }
  const env = (opts.env && typeof opts.env === 'object') ? opts.env : process.env;
  const audit = typeof opts.audit === 'function' ? opts.audit : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const agentId = typeof opts.agent === 'string' && opts.agent ? opts.agent : 'webhook';
  const onProcessed = typeof opts.onProcessed === 'function' ? opts.onProcessed : null;

  return http.createServer((req, res) => {
    handle(req, res, { subscriptions, ledger, env, audit, now, agentId, onProcessed }).catch((err) => {
      // Never let an unhandled rejection escape into a payload echo.
      const errorCategory = err && err.code ? String(err.code) : 'unhandled-error';
      respond(res, 500, audit, {
        id: null,
        status: 500,
        error: errorCategory,
      });
    });
  });
}

async function handle(req, res, ctx) {
  if (req.method !== 'POST') {
    return respond(res, 405, ctx.audit, { id: null, status: 405, error: 'method-not-allowed' });
  }

  const subscription = matchSubscription(ctx.subscriptions, req);
  if (!subscription) {
    return respond(res, 404, ctx.audit, { id: null, status: 404, error: 'no-matching-subscription' });
  }

  let bodyBuffer;
  try {
    bodyBuffer = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const category = err && err.code === 'BODY_TOO_LARGE' ? 'body-too-large' : 'body-read-failed';
    return respond(res, category === 'body-too-large' ? 413 : 400, ctx.audit, {
      id: subscription.id, status: category === 'body-too-large' ? 413 : 400, error: category,
    });
  }

  const secret = ctx.env[subscription.secretEnv];
  if (!secret || typeof secret !== 'string' || !secret.length) {
    return respond(res, 401, ctx.audit, {
      id: subscription.id, status: 401, error: 'secret-not-configured',
    });
  }

  if (!verifySignature(bodyBuffer, req.headers[subscription.signatureHeader], secret, subscription.signatureAlgo)) {
    return respond(res, 401, ctx.audit, {
      id: subscription.id, status: 401, error: 'signature-mismatch',
    });
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString('utf8'));
  } catch (_err) {
    return respond(res, 400, ctx.audit, {
      id: subscription.id, status: 400, error: 'invalid-json',
    });
  }

  const transformFn = transforms[subscription.bodyTransform];
  if (typeof transformFn !== 'function') {
    return respond(res, 500, ctx.audit, {
      id: subscription.id, status: 500, error: 'transform-not-registered',
    });
  }

  let body;
  try {
    body = transformFn(payload);
  } catch (err) {
    const category = err && err.message ? String(err.message).slice(0, 64) : 'transform-failed';
    return respond(res, 400, ctx.audit, {
      id: subscription.id, status: 400, error: `transform:${category}`,
    });
  }

  const taskId = buildTaskId(subscription.id, ctx.now());
  const summary = buildSummary(subscription, body);
  try {
    ctx.ledger.claimTask({
      agent: ctx.agentId,
      taskId,
      summary,
      forRole: subscription.role,
    });
    // The body projection is published as a separate fact record so that
    // the task-claim itself stays a small, schema-stable envelope. The
    // role's daemon can pick up both records via the same taskId.
    ctx.ledger.recordFact({
      agent: ctx.agentId,
      subject: `${subscription.subject}:${taskId}`,
      value: {
        schema: 'openclaw-frontier.webhook-event.v1',
        subscriptionId: subscription.id,
        bodyTransform: subscription.bodyTransform,
        body,
      },
      evidence: [],
    });
  } catch (err) {
    const category = err && err.code === 'BLACKBOARD_VALIDATION' ? 'blackboard-validation' : 'ledger-write-failed';
    return respond(res, 500, ctx.audit, {
      id: subscription.id, status: 500, error: category,
    });
  }

  respond(res, 202, ctx.audit, { id: subscription.id, status: 202, taskId });
  if (ctx.onProcessed) ctx.onProcessed({ subscriptionId: subscription.id, taskId });
  return null;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > max) {
        aborted = true;
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        try { req.destroy(); } catch (_) { /* ignore */ }
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
  });
}

function verifySignature(body, headerValue, secret, algo) {
  if (typeof headerValue !== 'string' || !headerValue) return false;
  // GitHub-style header looks like `sha256=<hex>`. Accept either that
  // prefixed form or a bare hex digest for generic callers.
  let provided = headerValue.trim();
  const eq = provided.indexOf('=');
  if (eq !== -1) {
    const prefix = provided.slice(0, eq).toLowerCase();
    if (prefix !== algo) return false;
    provided = provided.slice(eq + 1);
  }
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;
  let providedBuf;
  try {
    providedBuf = Buffer.from(provided, 'hex');
  } catch (_) {
    return false;
  }
  const expected = crypto.createHmac(algo, secret).update(body).digest();
  if (providedBuf.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(providedBuf, expected);
  } catch (_) {
    return false;
  }
}

function buildTaskId(subscriptionId, date) {
  // task ids are constrained by the blackboard to /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.
  const stamp = date.toISOString().replace(/[:.Z-]/g, '').replace(/T/, 't');
  // 8 hex chars of randomness keeps collision risk low while staying short.
  const rand = crypto.randomBytes(4).toString('hex');
  return `${TASK_ID_PREFIX}-${subscriptionId}-${stamp}-${rand}`;
}

function buildSummary(subscription, body) {
  const parts = [`webhook ${subscription.id}`];
  if (body && typeof body === 'object') {
    if (body.source) parts.push(`source=${body.source}`);
    if (body.repository) parts.push(`repo=${body.repository}`);
    if (body.action) parts.push(`action=${body.action}`);
    if (body.number != null) parts.push(`number=${body.number}`);
    if (body.ref) parts.push(`ref=${body.ref}`);
  }
  const text = parts.join(' ');
  return text.length > 500 ? text.slice(0, 500) : text;
}

function respond(res, status, audit, auditPayload) {
  // Never include the raw payload in error responses. Both success and
  // error responses share the same minimal shape so an attacker cannot
  // probe for subscription metadata by comparing response bodies.
  const body = JSON.stringify({
    ok: status >= 200 && status < 300,
    status,
    error: auditPayload && auditPayload.error ? auditPayload.error : undefined,
    taskId: auditPayload && auditPayload.taskId ? auditPayload.taskId : undefined,
  });
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
  try { audit(auditPayload); } catch (_) { /* never throw on audit */ }
}

module.exports = {
  createServer,
  // Exposed for unit tests only.
  _internals: {
    verifySignature,
    buildTaskId,
    buildSummary,
    readBody,
    MAX_BODY_BYTES,
  },
};
