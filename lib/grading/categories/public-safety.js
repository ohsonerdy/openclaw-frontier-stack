'use strict';

/**
 * public-safety — binary gate. The private-content scanner runs across the
 * public tree. Zero findings => 100. Any finding => 0. The composite layer
 * separately caps the final composite at 50 if this score is 0.
 */

const fs = require('fs');
const path = require('path');
const { scan } = require('../../../release-gate/lib/private-patterns.js');

function walk(root, dir, out, skipPrefixes) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'out'].includes(entry.name)) continue;
      if (skipPrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      walk(root, full, out, skipPrefixes);
    } else {
      out.push({ full, rel });
    }
  }
}

async function score(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..', '..');
  const skipPrefixes = [
    'release-gate/reports',
    'release-gate/artifacts',
    'release-gate/exports',
    'release-gate/scorecards',
  ];
  const files = [];
  walk(root, root, files, skipPrefixes);
  const findings = [];
  for (const file of files) {
    let text;
    try {
      const buf = fs.readFileSync(file.full);
      if (buf.indexOf(0) !== -1 && /\.(md|js|json|yaml|yml|txt|env|example|template|sh)$/i.test(file.rel)) {
        // Mirror verifier behaviour: treat as a finding.
        findings.push({ pattern: 'nul-byte-in-text-file', file: file.rel, line: 1 });
        continue;
      }
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    findings.push(...scan(file.rel, text));
  }
  const finalScore = findings.length === 0 ? 100 : 0;
  return {
    score: finalScore,
    detail: {
      findingCount: findings.length,
      gate: finalScore === 0,
      sampleFindings: findings.slice(0, 5).map((f) => ({
        file: f.file,
        line: f.line,
        pattern: f.pattern,
      })),
    },
  };
}

module.exports = { score };
