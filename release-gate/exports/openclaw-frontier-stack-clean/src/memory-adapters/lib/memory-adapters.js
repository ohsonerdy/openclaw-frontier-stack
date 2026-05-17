'use strict';

const crypto = require('crypto');

const SCHEMA = 'openclaw-frontier.memory-adapters.v1';
const DEFAULT_STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'for', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with']);

class MemoryAdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MemoryAdapterError';
    this.code = 'MEMORY_ADAPTER_VALIDATION';
    this.details = details;
  }
}

function requireString(value, label, max = 4000) {
  if (typeof value !== 'string') throw new MemoryAdapterError(`${label} must be a string`, { label });
  const trimmed = value.trim();
  if (!trimmed) throw new MemoryAdapterError(`${label} must not be empty`, { label });
  if (trimmed.length > max) throw new MemoryAdapterError(`${label} exceeds ${max} chars`, { label });
  return trimmed;
}

function validateId(value, label = 'id') {
  const id = requireString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new MemoryAdapterError(`${label} must be a simple id`, { label });
  return id;
}

function assertPublicSafe(value) {
  const text = JSON.stringify(value);
  const patterns = [
    ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
    ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
    ['ipv4', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ];
  for (const [id, regex] of patterns) if (regex.test(text)) throw new MemoryAdapterError(`public safety scan failed: ${id}`, { pattern: id });
}

function tokenize(text) {
  return requireString(text, 'text').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !DEFAULT_STOPWORDS.has(token)) || [];
}

function termVector(text) {
  const vector = new Map();
  for (const token of tokenize(text)) vector.set(token, (vector.get(token) || 0) + 1);
  return vector;
}

function cosine(a, b) {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (const value of a.values()) aMag += value * value;
  for (const value of b.values()) bMag += value * value;
  for (const [key, value] of a.entries()) dot += value * (b.get(key) || 0);
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

class LexicalVectorIndex {
  constructor() {
    this.docs = [];
  }

  addDocument({ id, text, metadata = {} }) {
    const doc = { schema: SCHEMA, id: validateId(id), text: requireString(text, 'text'), metadata, vector: termVector(text) };
    assertPublicSafe(doc);
    this.docs.push(doc);
    return { id: doc.id, tokens: doc.vector.size };
  }

  search(query, { limit = 3, minScore = 0 } = {}) {
    const queryVector = termVector(query);
    return this.docs
      .map((doc) => ({ id: doc.id, text: doc.text, metadata: doc.metadata, score: cosine(queryVector, doc.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

class CagPreloadCache {
  constructor() {
    this.entries = new Map();
  }

  put({ key, payload, sourceIds = [] }) {
    const safeKey = validateId(key, 'key');
    const entry = { schema: SCHEMA, key: safeKey, payload: requireString(payload, 'payload', 8000), sourceIds: sourceIds.map((id) => validateId(id, 'sourceId')) };
    entry.sha256 = crypto.createHash('sha256').update(JSON.stringify({ payload: entry.payload, sourceIds: entry.sourceIds })).digest('hex');
    assertPublicSafe(entry);
    this.entries.set(safeKey, entry);
    return { key: safeKey, sha256: entry.sha256, bytes: Buffer.byteLength(entry.payload) };
  }

  get(key) {
    const entry = this.entries.get(validateId(key, 'key'));
    return entry ? { ...entry, sourceIds: entry.sourceIds.slice() } : null;
  }
}

function compactTranscript({ id, messages, maxChars = 500 }) {
  const safeId = validateId(id);
  if (!Array.isArray(messages)) throw new MemoryAdapterError('messages must be an array');
  if (!Number.isInteger(maxChars) || maxChars < 40 || maxChars > 4000) throw new MemoryAdapterError('maxChars must be an integer between 40 and 4000', { maxChars });
  const joined = messages.map((message) => requireString(String(message), 'message', 2000)).join('\n');
  assertPublicSafe({ id: safeId, messages: joined });
  const marker = '... [compacted]';
  const summary = joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
  const result = { schema: SCHEMA, id: safeId, summary, sourceCount: messages.length, sha256: crypto.createHash('sha256').update(joined).digest('hex') };
  assertPublicSafe(result);
  return result;
}

function promotionFilter(candidate) {
  const text = requireString(candidate.text, 'candidate.text', 4000);
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map((tag) => requireString(String(tag), 'tag', 64)) : [];
  assertPublicSafe({ text, tags });
  const durable = tags.includes('decision') || tags.includes('architecture') || tags.includes('release-gate');
  const rejected = /\b(secret|token|password|oauth|private key|raw log|session dump)\b/i.test(text);
  const result = { schema: SCHEMA, accept: durable && !rejected, durable, rejected, reason: rejected ? 'private-or-sensitive-shape' : durable ? 'durable-tag' : 'not-durable' };
  assertPublicSafe(result);
  return result;
}

module.exports = { SCHEMA, MemoryAdapterError, LexicalVectorIndex, CagPreloadCache, compactTranscript, promotionFilter, tokenize };
