'use strict';

/**
 * signed-bus-client.js. OpenClaw Frontier transport client over NATS JetStream.
 *
 * Subject routing: squad.<TYPE>.<to>
 *   squad.TASK.rei     point-to-point
 *   squad.HEARTBEAT.*  broadcast (wildcard handled at subscribe time)
 *
 * Stream config: name=SQUAD, file storage, 7 day max_age, 100 MB max_bytes.
 *
 * Env overrides:
 *   SQUAD_BUS_URL          default nats://localhost:4222
 *   SQUAD_BUS_AGENT_ID     required. for example: neo | architect | sentinel | scout | builder | reviewer
 *   SQUAD_BUS_PRIV_KEY     default ./keys/<agent>.pem for demos; set explicitly in production
 *   SQUAD_BUS_KEYS_DIR     default <home>/squad/KEYS
 *   SQUAD_BUS_AUDIT_PATH   default <repo>/data/audit.ndjson
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
let natsApi = null;
function loadNats() {
  if (natsApi) return natsApi;
  try {
    natsApi = require('nats');
    return natsApi;
  } catch (err) {
    const e = new Error('Optional dependency nats is required for signed-bus transport. Install with npm install nats or include optionalDependencies.');
    e.cause = err;
    throw e;
  }
}
const env = require('./envelope');

const HOME = process.env.USERPROFILE || process.env.HOME;

const AGENT_ID = (process.env.SQUAD_BUS_AGENT_ID || '').toLowerCase();
const BUS_URL = process.env.SQUAD_BUS_URL || 'nats://localhost:4222';
const KEYS_DIR = process.env.SQUAD_BUS_KEYS_DIR || path.join(process.cwd(), 'keys');
const PRIV_KEY_PATH = process.env.SQUAD_BUS_PRIV_KEY
  || path.join(process.cwd(), 'keys', `${AGENT_ID || 'neo'}.pem`);
const AUDIT_PATH = process.env.SQUAD_BUS_AUDIT_PATH
  || path.join(__dirname, '..', 'data', 'audit.ndjson');

const STREAM_NAME = 'SQUAD';
const SUBJECT_ROOT = 'squad';
const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_BYTES = 100 * 1024 * 1024;
const DEDUPE_MAX = Number.parseInt(process.env.SQUAD_BUS_DEDUPE_MAX || '10000', 10);

let sc = null;
function codec() {
  if (!sc) sc = loadNats().StringCodec();
  return sc;
}

let _nc = null;
let _streamEnsured = false;
const _seenEnvelopeIds = new Set();

function _markSeen(id) {
  if (!id) return false;
  if (_seenEnvelopeIds.has(id)) return false;
  _seenEnvelopeIds.add(id);
  if (_seenEnvelopeIds.size > DEDUPE_MAX) {
    const first = _seenEnvelopeIds.values().next().value;
    _seenEnvelopeIds.delete(first);
  }
  return true;
}

function _audit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(
      AUDIT_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
      'utf8',
    );
  } catch (err) {
    process.stderr.write(`[squad-bus] audit write failed: ${err.message}\n`);
  }
}

async function _connect() {
  if (_nc && !_nc.isClosed()) return _nc;
  const { connect } = loadNats();
  _nc = await connect({ servers: [BUS_URL], name: `squad-bus-${AGENT_ID || 'unknown'}` });
  process.stderr.write(`[squad-bus] connected to ${BUS_URL} as ${AGENT_ID}\n`);
  return _nc;
}

async function _ensureStream(nc) {
  if (_streamEnsured) return;
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch {
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: [`${SUBJECT_ROOT}.>`],
      storage: 'file',
      retention: 'limits',
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      num_replicas: 1,
    });
    _audit({ event: 'STREAM_CREATED', stream: STREAM_NAME });
    process.stderr.write(`[squad-bus] created JetStream stream ${STREAM_NAME}\n`);
  }
  _streamEnsured = true;
}

/**
 * Build and sign an envelope.
 * AGENT_ID and PRIV_KEY_PATH come from env. Throws if either is missing.
 */
function createSignedEnvelope({ to, type, subject, body, lineage }) {
  if (!AGENT_ID) throw new Error('SQUAD_BUS_AGENT_ID env var is required');
  if (!fs.existsSync(PRIV_KEY_PATH)) {
    throw new Error(`Private key not found at ${PRIV_KEY_PATH}. Set SQUAD_BUS_PRIV_KEY or generate the key.`);
  }
  const envelope = env.createEnvelope({ from: AGENT_ID, to, type, subject, body, lineage });
  env.sign(envelope, PRIV_KEY_PATH);
  return envelope;
}

/**
 * Publish a signed envelope to the bus.
 * Subject: squad.<TYPE>.<to>
 */
async function publish(envelope) {
  if (!envelope.signature) {
    if (!fs.existsSync(PRIV_KEY_PATH)) {
      throw new Error(`Cannot sign on publish, private key missing at ${PRIV_KEY_PATH}`);
    }
    env.sign(envelope, PRIV_KEY_PATH);
  }
  const nc = await _connect();
  await _ensureStream(nc);
  const js = nc.jetstream();
  const subject = `${SUBJECT_ROOT}.${envelope.type}.${envelope.to}`;
  await js.publish(subject, codec().encode(JSON.stringify(envelope)));
  _audit({ event: 'PUBLISH', id: envelope.id, type: envelope.type, from: envelope.from, to: envelope.to, subject });
}

/**
 * Subscribe to a subject filter. Verified envelopes are passed to handler.
 * Unverified envelopes are dropped + audited, never reach handler.
 *
 * @param {string} filter   e.g. '>' for all, 'TASK.*', 'TASK.neo', 'HEARTBEAT.>'
 * @param {function} handler async (envelope) => void
 * @param {object} [opts]
 * @param {string} [opts.deliverPolicy] 'new' (default) or 'all'
 * @returns {Promise<function>} unsubscribe
 */
async function subscribe(filter, handler, opts = {}) {
  const nc = await _connect();
  await _ensureStream(nc);
  const js = nc.jetstream();
  const subject = `${SUBJECT_ROOT}.${filter}`;

  // nats@2.x requires deliver_subject for push consumers. Use auto-inbox.
  const sub = await js.subscribe(subject, {
    config: {
      deliver_policy: opts.deliverPolicy || 'new',
      deliver_subject: loadNats().createInbox(),
    },
  });

  (async () => {
    for await (const msg of sub) {
      try {
        const envelope = JSON.parse(codec().decode(msg.data));
        const v = env.verify(envelope, { keysDir: KEYS_DIR });
        if (!v.valid) {
          _audit({ event: 'DROP', id: envelope.id, from: envelope.from, reason: v.reason });
          process.stderr.write(`[squad-bus] DROP ${envelope.id} from ${envelope.from}: ${v.reason}\n`);
          msg.ack();
          continue;
        }
        if (!_markSeen(envelope.id)) {
          _audit({ event: 'DUPLICATE_DROP', id: envelope.id, type: envelope.type, from: envelope.from, to: envelope.to });
          msg.ack();
          continue;
        }
        _audit({ event: 'RECEIVE', id: envelope.id, type: envelope.type, from: envelope.from, to: envelope.to });
        await handler(envelope);
        msg.ack();
      } catch (err) {
        process.stderr.write(`[squad-bus] handler error: ${err.message}\n`);
        msg.nak();
      }
    }
  })().catch((err) => process.stderr.write(`[squad-bus] subscribe loop crash: ${err.message}\n`));

  return () => sub.unsubscribe();
}

async function close() {
  if (_nc && !_nc.isClosed()) {
    await _nc.drain();
    _nc = null;
    _streamEnsured = false;
  }
}

module.exports = {
  createSignedEnvelope,
  publish,
  subscribe,
  close,
  // testing surfaces
  _envelope: env,
  _BUS_URL: BUS_URL,
  _AGENT_ID: AGENT_ID,
  _PRIV_KEY_PATH: PRIV_KEY_PATH,
  _KEYS_DIR: KEYS_DIR,
};
