#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const docRel = 'docs/graph-system.md';
const cfgRel = 'templates/config/graph.example.json';
const findings = [];
const denied = [
  ['home-path', /\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token', /\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[abpors]-[A-Za-z0-9-]{20,})\b/],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['ipv4-address', /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/],
  ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['forbidden-domain', /\b(?:finance|financial|trading|portfolio|alpaca|quiltt)\b/i],
];
function readChecked(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    findings.push({ issue: 'missing-file', path: rel });
    return '';
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const [id, regex] of denied) {
    if (regex.test(text)) findings.push({ issue: 'denied-pattern', path: rel, pattern: id });
  }
  return text;
}
const doc = readChecked(docRel);
for (const phrase of ['Node types', 'Edge types', 'Minimal graph record', 'Status vocabulary', 'Graph-to-release rule', 'templates/config/graph.example.json']) {
  if (!doc.includes(phrase)) findings.push({ issue: 'missing-doc-phrase', phrase });
}
const jsonText = readChecked(cfgRel);
if (jsonText) {
  try {
    const graph = JSON.parse(jsonText);
    if (graph.schema !== 'openclaw-frontier.graph.v1') findings.push({ issue: 'bad-schema' });
    if (!Array.isArray(graph.nodes) || graph.nodes.length < 5) findings.push({ issue: 'too-few-nodes' });
    if (!Array.isArray(graph.edges) || graph.edges.length < 4) findings.push({ issue: 'too-few-edges' });
    const nodeIds = new Set((graph.nodes || []).map((n) => n.id));
    const allowedNodeTypes = new Set(['agent', 'capability', 'task', 'artifact', 'review', 'channel', 'release']);
    const allowedEdgeTypes = new Set(['owns', 'implements', 'documents', 'depends_on', 'verified_by', 'publishes_to', 'routes_to', 'blocks']);
    const allowedStatuses = new Set(['running', 'packaged', 'planned', 'blocked', 'excluded']);
    for (const node of graph.nodes || []) {
      for (const key of ['id', 'type', 'label', 'status', 'risk_tier']) {
        if (!(key in node)) findings.push({ issue: 'missing-node-field', id: node.id || null, field: key });
      }
      if (!allowedNodeTypes.has(node.type)) findings.push({ issue: 'bad-node-type', id: node.id, type: node.type });
      if (!allowedStatuses.has(node.status)) findings.push({ issue: 'bad-node-status', id: node.id, status: node.status });
    }
    for (const edge of graph.edges || []) {
      for (const key of ['from', 'to', 'type']) {
        if (!(key in edge)) findings.push({ issue: 'missing-edge-field', edge, field: key });
      }
      if (!nodeIds.has(edge.from)) findings.push({ issue: 'edge-from-missing-node', from: edge.from });
      if (!nodeIds.has(edge.to)) findings.push({ issue: 'edge-to-missing-node', to: edge.to });
      if (!allowedEdgeTypes.has(edge.type)) findings.push({ issue: 'bad-edge-type', type: edge.type });
    }
  } catch (err) {
    findings.push({ issue: 'invalid-json', error: err.message });
  }
}
const ok = findings.length === 0;
console.log(JSON.stringify({
  schema: 'openclaw-frontier.graph-system-verification.v1',
  ok,
  files: [docRel, cfgRel],
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
