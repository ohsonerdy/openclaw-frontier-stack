'use strict';

const crypto = require('crypto');

const SCHEMA = 'openclaw-frontier.integration-adapter.v1';
const TRAJECTORY_SCHEMA = 'openclaw-frontier.mcp-tool-trajectory.v1';

class IntegrationAdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IntegrationAdapterError';
    this.code = 'INTEGRATION_ADAPTER_VALIDATION';
    this.details = details;
  }
}

function requireString(value, label, max = 1000) {
  if (typeof value !== 'string') throw new IntegrationAdapterError(`${label} must be a string`, { label });
  const trimmed = value.trim();
  if (!trimmed) throw new IntegrationAdapterError(`${label} must not be empty`, { label });
  if (trimmed.length > max) throw new IntegrationAdapterError(`${label} exceeds ${max} chars`, { label });
  return trimmed;
}

function validateToolName(value) {
  const name = requireString(value, 'toolName', 80);
  if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new IntegrationAdapterError('toolName must be lowercase and simple', { name });
  return name;
}

function assertPublicSafe(value) {
  const text = JSON.stringify(value);
  const patterns = [
    ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
    ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
    ['ipv4', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
    ['private-url', /https?:\/\/(?:localhost|127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})/i],
  ];
  for (const [id, regex] of patterns) if (regex.test(text)) throw new IntegrationAdapterError(`public safety scan failed: ${id}`, { pattern: id });
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeShape(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value).sort().slice(0, 20) };
  return { type: typeof value };
}

function normalizeArtifacts(artifacts = []) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.slice(0, 20).map((artifact, index) => {
    const item = artifact && typeof artifact === 'object' ? artifact : { ref: String(artifact) };
    const out = {
      id: requireString(String(item.id || `artifact-${index + 1}`), 'artifact.id', 120),
      type: requireString(String(item.type || 'reference'), 'artifact.type', 80),
    };
    if (item.path) out.path = requireString(String(item.path), 'artifact.path', 240);
    if (item.sha256) out.sha256 = requireString(String(item.sha256), 'artifact.sha256', 80);
    if (item.note) out.note = requireString(String(item.note), 'artifact.note', 240);
    assertPublicSafe(out);
    return out;
  });
}

function scoreToolTrajectory(records) {
  const entries = Array.isArray(records) ? records : [];
  if (entries.length === 0) {
    return {
      score: 0,
      label: 'no-evidence',
      factors: { successRate: 0, latencyHealth: 0, artifactCoverage: 0, sequenced: false },
    };
  }
  const successRate = entries.filter((entry) => entry.status === 'ok').length / entries.length;
  const avgLatencyMs = entries.reduce((sum, entry) => sum + entry.latencyMs, 0) / entries.length;
  const latencyHealth = Math.max(0, Math.min(1, 1 - (avgLatencyMs / 5000)));
  const artifactCoverage = entries.filter((entry) => entry.artifacts.length > 0).length / entries.length;
  const sequenced = entries.every((entry, index) => entry.sequence === index + 1);
  const score = Math.round(((successRate * 0.55) + (latencyHealth * 0.2) + (artifactCoverage * 0.2) + (sequenced ? 0.05 : 0)) * 100) / 100;
  const label = score >= 0.9 ? 'high' : score >= 0.7 ? 'medium' : score >= 0.4 ? 'low' : 'insufficient';
  return {
    score,
    label,
    factors: {
      successRate: Number(successRate.toFixed(3)),
      averageLatencyMs: Math.round(avgLatencyMs),
      latencyHealth: Number(latencyHealth.toFixed(3)),
      artifactCoverage: Number(artifactCoverage.toFixed(3)),
      sequenced,
    },
  };
}

class ToolTrajectoryLog {
  constructor({ traceId = 'demo-mcp-trace-001' } = {}) {
    this.traceId = requireString(traceId, 'traceId', 120);
    assertPublicSafe({ traceId: this.traceId });
    this.records = [];
  }

  record({ toolName, status, latencyMs, input, result, error, artifacts = [] }) {
    const entry = {
      sequence: this.records.length + 1,
      schema: TRAJECTORY_SCHEMA,
      traceId: this.traceId,
      toolName: validateToolName(toolName),
      status: status === 'ok' ? 'ok' : 'error',
      latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
      inputShape: summarizeShape(input),
      inputSha256: sha256(input || {}),
      resultShape: status === 'ok' ? summarizeShape(result) : undefined,
      resultSha256: status === 'ok' ? sha256(result || {}) : undefined,
      error: status === 'ok' ? undefined : {
        name: requireString(String((error && error.name) || 'Error'), 'error.name', 120),
        code: error && error.code ? requireString(String(error.code), 'error.code', 120) : 'TOOL_CALL_ERROR',
      },
      artifacts: normalizeArtifacts(artifacts),
    };
    assertPublicSafe(entry);
    this.records.push(entry);
    return cloneJson(entry);
  }

  toJSON() {
    const records = cloneJson(this.records);
    return {
      schema: TRAJECTORY_SCHEMA,
      traceId: this.traceId,
      generatedAt: new Date().toISOString(),
      records,
      reliability: scoreToolTrajectory(records),
      publicSafe: true,
    };
  }
}

class MockMcpAdapter {
  constructor({ tools = {}, trajectoryLog } = {}) {
    this.tools = new Map();
    this.trajectoryLog = trajectoryLog || new ToolTrajectoryLog();
    for (const [name, handler] of Object.entries(tools)) this.registerTool(name, handler);
  }

  registerTool(name, handler) {
    const toolName = validateToolName(name);
    if (typeof handler !== 'function') throw new IntegrationAdapterError('handler must be a function', { toolName });
    this.tools.set(toolName, handler);
    return { schema: SCHEMA, registered: toolName };
  }

  listTools() {
    return { schema: SCHEMA, tools: Array.from(this.tools.keys()).sort() };
  }

  getToolTrajectory() {
    return this.trajectoryLog.toJSON();
  }

  async callTool(name, input = {}) {
    const started = Date.now();
    const toolName = validateToolName(name);
    try {
      if (!this.tools.has(toolName)) throw new IntegrationAdapterError('unknown tool', { toolName });
      assertPublicSafe({ toolName, input });
      const result = await this.tools.get(toolName)(Object.freeze({ ...input }));
      const envelope = { schema: SCHEMA, toolName, ok: true, result };
      assertPublicSafe(envelope);
      this.trajectoryLog.record({
        toolName,
        status: 'ok',
        latencyMs: Date.now() - started,
        input,
        result,
        artifacts: result && result.artifacts,
      });
      return envelope;
    } catch (error) {
      this.trajectoryLog.record({ toolName, status: 'error', latencyMs: Date.now() - started, input: {}, error, artifacts: [] });
      throw error;
    }
  }
}

function createDemoAdapter() {
  return new MockMcpAdapter({ tools: {
    'knowledge.search': ({ query = '' }) => {
      const q = requireString(String(query), 'query', 200).toLowerCase();
      const docs = [
        { id: 'doc-signed-bus', text: 'Signed envelopes carry task and result coordination.' },
        { id: 'doc-blackboard', text: 'Blackboard claims prevent path collisions.' },
        { id: 'doc-release-gate', text: 'Release gates require verifier output and reviewer approval.' },
      ];
      const hits = docs.filter((doc) => doc.text.toLowerCase().includes(q) || q.split(/\s+/).some((part) => doc.text.toLowerCase().includes(part)));
      return {
        hits: hits.slice(0, 3),
        artifacts: [{ id: 'synthetic-knowledge-index', type: 'demo-corpus', path: 'examples/synthetic/knowledge-index.json' }],
      };
    },
    'artifact.summarize': ({ title = '', body = '' }) => ({
      title: requireString(String(title), 'title', 120),
      summary: requireString(String(body), 'body', 1000).slice(0, 160),
      artifacts: [{ id: 'synthetic-summary', type: 'summary', path: 'examples/synthetic/summary.md' }],
    }),
  } });
}

module.exports = {
  SCHEMA,
  TRAJECTORY_SCHEMA,
  IntegrationAdapterError,
  MockMcpAdapter,
  ToolTrajectoryLog,
  createDemoAdapter,
  scoreToolTrajectory,
};
