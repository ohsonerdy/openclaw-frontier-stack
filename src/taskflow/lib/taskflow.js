'use strict';

const crypto = require('crypto');

const SCHEMA = 'openclaw-frontier.taskflow.v1';
const STATES = new Set(['queued', 'claimed', 'waiting', 'done', 'failed', 'blocked']);
const RESULT_STATES = new Set(['ok', 'failed', 'blocked']);

class TaskFlowError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TaskFlowError';
    this.code = 'TASKFLOW_VALIDATION';
    this.details = details;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskFlowError(`${label} must be an object`);
  return value;
}

function requireString(value, label, max = 500) {
  if (typeof value !== 'string') throw new TaskFlowError(`${label} must be a string`, { label });
  const trimmed = value.trim();
  if (!trimmed) throw new TaskFlowError(`${label} must not be empty`, { label });
  if (trimmed.length > max) throw new TaskFlowError(`${label} exceeds ${max} chars`, { label });
  return trimmed;
}

function validateId(value, label = 'id') {
  const id = requireString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new TaskFlowError(`${label} must be a simple id`, { label });
  return id;
}

function validateAgent(value, label = 'agent') {
  const id = requireString(value, label, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new TaskFlowError(`${label} must be a simple agent id`, { label });
  return id;
}

function validateRelPath(value, label = 'artifact') {
  const p = requireString(value, label, 512).replace(/\\/g, '/');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) || p.startsWith('/') || p.startsWith('~') || p.includes('\0')) {
    throw new TaskFlowError(`${label} must be a relative package path`, { value });
  }
  const parts = p.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new TaskFlowError(`${label} has unsafe path segment`, { value });
  if (/(^|[\/_.-])(secret|token|credential|password|private|oauth|session|vault|key)([\/_.-]|$)/i.test(p)) {
    throw new TaskFlowError(`${label} contains secret-like segment`, { value });
  }
  return p;
}

function scanPublicSafe(value) {
  const text = JSON.stringify(value);
  const patterns = [
    ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
    ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
    ['ipv4', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ];
  for (const [id, regex] of patterns) if (regex.test(text)) throw new TaskFlowError(`public safety scan failed: ${id}`, { pattern: id });
}

function uuid(prefix) {
  return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;
}

class TaskFlowRuntime {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.events = [];
  }

  append(kind, body) {
    const event = { schema: SCHEMA, id: uuid(kind), ts: this.now(), kind, ...body };
    scanPublicSafe(event);
    this.events.push(event);
    return event;
  }

  createTask({ taskId = uuid('task'), title, owner = 'orchestrator', priority = 'normal', inputs = {}, dependsOn = [] }) {
    const deps = dependsOn.map((id) => validateId(id, 'dependsOn'));
    return this.append('task-created', {
      taskId: validateId(taskId, 'taskId'),
      title: requireString(title, 'title', 200),
      owner: validateAgent(owner, 'owner'),
      priority: requireString(priority, 'priority', 32),
      inputs: requireObject(inputs, 'inputs'),
      dependsOn: deps,
      state: 'queued',
    });
  }

  claimTask({ taskId, agent }) {
    const task = this.snapshot().tasks[validateId(taskId, 'taskId')];
    if (!task) throw new TaskFlowError('task does not exist', { taskId });
    if (task.state === 'done' || task.state === 'failed') throw new TaskFlowError('task is already terminal', { taskId, state: task.state });
    return this.append('task-claimed', { taskId: validateId(taskId, 'taskId'), agent: validateAgent(agent), state: 'claimed' });
  }

  waitTask({ taskId, agent, reason, wakeAfter = '' }) {
    return this.append('task-waiting', {
      taskId: validateId(taskId, 'taskId'),
      agent: validateAgent(agent),
      reason: requireString(reason, 'reason', 500),
      wakeAfter: wakeAfter ? requireString(wakeAfter, 'wakeAfter', 128) : '',
      state: 'waiting',
    });
  }

  blockTask({ taskId, agent, reason }) {
    return this.append('task-blocked', {
      taskId: validateId(taskId, 'taskId'),
      agent: validateAgent(agent),
      reason: requireString(reason, 'reason', 500),
      state: 'blocked',
    });
  }

  completeTask({ taskId, agent, status = 'ok', summary, artifacts = [] }) {
    const safeTaskId = validateId(taskId, 'taskId');
    const task = this.snapshot().tasks[safeTaskId];
    if (!task) throw new TaskFlowError('task does not exist', { taskId: safeTaskId });
    const safeStatus = requireString(status, 'status', 32);
    if (!RESULT_STATES.has(safeStatus)) throw new TaskFlowError('invalid result status', { status });
    return this.append('task-result', {
      taskId: safeTaskId,
      agent: validateAgent(agent),
      status: safeStatus,
      summary: requireString(summary, 'summary', 1000),
      artifacts: artifacts.map((artifact) => validateRelPath(artifact)),
      state: safeStatus === 'ok' ? 'done' : safeStatus,
    });
  }

  snapshot() {
    const tasks = {};
    for (const event of this.events) {
      if (event.kind === 'task-created') {
        tasks[event.taskId] = {
          taskId: event.taskId,
          title: event.title,
          owner: event.owner,
          priority: event.priority,
          inputs: event.inputs,
          dependsOn: event.dependsOn,
          state: 'queued',
          createdAt: event.ts,
          history: [event.id],
        };
      } else if (event.taskId && tasks[event.taskId]) {
        const task = tasks[event.taskId];
        task.history.push(event.id);
        if (event.agent) task.agent = event.agent;
        if (event.state) task.state = event.state;
        if (event.reason) task.reason = event.reason;
        if (event.summary) task.summary = event.summary;
        if (event.artifacts) task.artifacts = event.artifacts;
        task.updatedAt = event.ts;
      }
    }
    const counts = {};
    for (const event of this.events) counts[event.kind] = (counts[event.kind] || 0) + 1;
    return { schema: SCHEMA, tasks, counts, events: this.events.slice() };
  }
}

module.exports = { SCHEMA, STATES: Array.from(STATES), TaskFlowError, TaskFlowRuntime, validateRelPath };
