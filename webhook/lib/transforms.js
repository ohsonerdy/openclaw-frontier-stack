'use strict';

/**
 * webhook/lib/transforms.js — payload-shape transforms.
 *
 * Each transform takes a raw JSON-decoded payload object and returns the
 * `body` portion of a task-claim envelope. The transform is responsible
 * for projecting the payload onto a minimal, public-safe shape — no
 * tokens, no email addresses, no internal identifiers beyond what the
 * upstream system already publishes openly.
 *
 * Every transform returns a plain object with only string, number, and
 * boolean leaf values. Nested objects are allowed but must be hand-curated
 * here rather than splatting unknown fields from the source payload.
 */

function pickString(value, max = 500) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function pickNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function repoFullName(repo) {
  if (!repo || typeof repo !== 'object') return null;
  // GitHub publishes both `full_name` (owner/name) and a nested object;
  // prefer `full_name` because it is the canonical public identifier.
  return pickString(repo.full_name) || (pickString(repo.owner && repo.owner.login) && pickString(repo.name)
    ? `${repo.owner.login}/${repo.name}`
    : null);
}

function githubPullRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload-not-object');
  }
  const pr = payload.pull_request && typeof payload.pull_request === 'object' ? payload.pull_request : {};
  return {
    source: 'github-pr',
    repository: repoFullName(payload.repository),
    action: pickString(payload.action, 64),
    number: pickNumber(payload.number != null ? payload.number : pr.number),
    title: pickString(pr.title, 300),
  };
}

function githubIssue(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload-not-object');
  }
  const issue = payload.issue && typeof payload.issue === 'object' ? payload.issue : {};
  return {
    source: 'github-issue',
    repository: repoFullName(payload.repository),
    action: pickString(payload.action, 64),
    number: pickNumber(issue.number),
    title: pickString(issue.title, 300),
  };
}

function githubPush(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload-not-object');
  }
  // GitHub push events do not have an `action` field — the action is
  // implicitly `push`. The `ref` (e.g. refs/heads/main) is the closest
  // analogue to a "subject" for routing.
  return {
    source: 'github-push',
    repository: repoFullName(payload.repository),
    action: 'push',
    ref: pickString(payload.ref, 256),
    // Commit count is a small, public, useful summary number.
    commits: Array.isArray(payload.commits) ? payload.commits.length : 0,
  };
}

function genericJson(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload-not-object');
  }
  // The generic transform refuses to forward unknown payload bodies
  // wholesale — that would let an attacker stuff arbitrary content into
  // the blackboard via a valid HMAC. Only allow a fixed set of public,
  // string/number leaf fields.
  const out = { source: 'generic-json' };
  const subject = pickString(payload.subject, 200);
  if (subject) out.subject = subject;
  const action = pickString(payload.action, 64);
  if (action) out.action = action;
  const id = pickString(payload.id, 128);
  if (id) out.id = id;
  const title = pickString(payload.title, 300);
  if (title) out.title = title;
  const priority = pickString(payload.priority, 32);
  if (priority) out.priority = priority;
  return out;
}

const transforms = {
  'github-pr': githubPullRequest,
  'github-issue': githubIssue,
  'github-push': githubPush,
  'generic-json': genericJson,
};

module.exports = { transforms };
