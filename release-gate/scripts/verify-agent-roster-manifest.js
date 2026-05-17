#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const docRel = 'docs/agent-roster-manifest.md';
const jsonRel = 'templates/config/agent-roster.example.json';
const docPath = path.join(root, docRel);
const jsonPath = path.join(root, jsonRel);
const findings = [];

const deniedPatterns = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['ipv4-address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['forbidden-domain', /\b(?:finance|financial|trading|portfolio|alpaca|quiltt)\b/i],
];

function checkText(rel, full) {
  if (!fs.existsSync(full)) {
    findings.push({ issue: 'missing-file', path: rel });
    return '';
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const [id, re] of deniedPatterns) {
    if (re.test(text)) findings.push({ issue: 'denied-pattern', path: rel, pattern: id });
  }
  return text;
}

const doc = checkText(docRel, docPath);
for (const phrase of ['Required fields', 'Orchestrator behavior', 'must not authorize', 'templates/config/agent-roster.example.json']) {
  if (!doc.includes(phrase)) findings.push({ issue: 'missing-doc-phrase', phrase });
}

const jsonText = checkText(jsonRel, jsonPath);
if (jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed.schema !== 'openclaw-frontier.agent-roster.v1') findings.push({ issue: 'bad-schema' });
    if (!Array.isArray(parsed.agents) || parsed.agents.length < 2) findings.push({ issue: 'missing-example-agents' });
    const required = ['agent_id', 'display_name', 'owner_host_label', 'primary_roles', 'capabilities', 'coordination_channels', 'risk_tier', 'approval_required_for', 'status_source'];
    for (const [idx, agent] of (parsed.agents || []).entries()) {
      for (const key of required) {
        if (!(key in agent)) findings.push({ issue: 'missing-agent-field', index: idx, field: key });
      }
      if (!['low', 'medium', 'high'].includes(agent.risk_tier)) findings.push({ issue: 'bad-risk-tier', index: idx });
    }
  } catch (err) {
    findings.push({ issue: 'invalid-json', error: err.message });
  }
}

const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.agent-roster-manifest-verification.v1',
  ok,
  files: [docRel, jsonRel],
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
