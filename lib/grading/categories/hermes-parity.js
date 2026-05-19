'use strict';

/**
 * hermes-parity — parse docs/hermes-agent-audit.md, count HIGH-priority gap-
 * table rows whose capability has now shipped in OFS, divide.
 *
 * The audit's gap table starts at `## 4. Gap Table` and uses markdown table
 * rows with `| Priority |` as the trailing column. Each row's "Hermes feature"
 * column gives the capability name; we match a small set of canonical names
 * against the actual ship state of this repo (presence of bin/cron daemon,
 * webhook daemon, doctor subcommand, etc.).
 *
 * Score = round(highShipped / highTotal * 100).
 */

const fs = require('fs');
const path = require('path');

function loadGapTable(text) {
  const startMatch = text.match(/^##\s+4\.\s+Gap Table/m);
  if (!startMatch) return [];
  const remainder = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = remainder.match(/\n##\s+\d/);
  const section = endMatch ? remainder.slice(0, endMatch.index) : remainder;
  const lines = section.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  const rows = [];
  for (const line of lines) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (cells[0] === '---' || cells[0] === '#' || /^-+$/.test(cells[0])) continue;
    // Skip the header row.
    if (/feature/i.test(cells[1]) && /priority/i.test(cells[5])) continue;
    rows.push({
      index: cells[0],
      feature: cells[1],
      description: cells[2],
      ourEquivalent: cells[3],
      port: cells[4],
      priority: cells[5],
    });
  }
  return rows;
}

function fileExists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function pkgHasScript(root, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts && pkg.scripts[name]);
  } catch { return false; }
}

function hooksJsonHasEvent(root, name) {
  try {
    const text = fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8');
    const obj = JSON.parse(text);
    return Boolean(obj && obj.events && Object.prototype.hasOwnProperty.call(obj.events, name));
  } catch { return false; }
}

// Map gap-table feature names to a presence check that returns true when the
// capability is shipped in this repo.
function buildShippingChecks(root) {
  return [
    { keywords: ['cron scheduler'], check: () => fileExists(root, 'bin/openclaw-cron') && fileExists(root, 'cron/lib') },
    { keywords: ['webhook subscription'], check: () => fileExists(root, 'bin/openclaw-webhook') && fileExists(root, 'webhook/lib') },
    { keywords: ['gateway hook lifecycle', 'event-hook lifecycle'], check: () => hooksJsonHasEvent(root, 'goal:start') && fileExists(root, 'lib/hooks/dispatcher.js') },
    { keywords: ['shell-script hook contract'], check: () => fileExists(root, 'lib/hooks/dispatcher.js') && fileExists(root, 'release-gate/hook-allowlist.json') },
    { keywords: ['supply-chain advisory'], check: () => pkgHasScript(root, 'verify:supply-chain') && fileExists(root, 'release-gate/scripts/verify-supply-chain-advisory.js') },
    { keywords: ['doctor command'], check: () => fileExists(root, 'lib/doctor/index.js') && fileExists(root, 'docs/doctor.md') },
  ];
}

function rowMatches(row, keywords) {
  const text = `${row.feature || ''} ${row.description || ''}`.toLowerCase();
  return keywords.some((k) => text.includes(k.toLowerCase()));
}

async function score(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..', '..');
  const docPath = path.join(root, 'docs', 'hermes-agent-audit.md');
  if (!fs.existsSync(docPath)) {
    return {
      score: null,
      detail: { reason: 'docs/hermes-agent-audit.md not found' },
    };
  }
  const text = fs.readFileSync(docPath, 'utf8');
  const rows = loadGapTable(text);
  const highRows = rows.filter((r) => /HIGH/i.test(r.priority || ''));
  const checks = buildShippingChecks(root);
  const closed = [];
  const open = [];
  for (const row of highRows) {
    let matched = false;
    for (const check of checks) {
      if (rowMatches(row, check.keywords)) {
        const isShipped = Boolean(check.check());
        if (isShipped) closed.push({ index: row.index, feature: row.feature });
        else open.push({ index: row.index, feature: row.feature, reason: 'capability declared HIGH but not yet detected on disk' });
        matched = true;
        break;
      }
    }
    if (!matched) {
      open.push({ index: row.index, feature: row.feature, reason: 'no shipping check defined for this HIGH row' });
    }
  }
  const total = highRows.length;
  const closedCount = closed.length;
  const finalScore = total === 0 ? 100 : Math.round((closedCount / total) * 100);
  return {
    score: finalScore,
    detail: {
      highRowsTotal: total,
      closed: closedCount,
      open: open.length,
      closedRows: closed,
      openRows: open,
    },
  };
}

module.exports = { score };
