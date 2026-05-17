'use strict';

const SELF = /release-gate\/lib\/private-patterns\.js$/;
const PATTERNS = [
  { id: 'email-address', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { id: 'long-numeric-chat-id', regex: /\b-?100\d{8,}\b/ },
  { id: 'telegram-bot-token', regex: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { id: 'posix-home-path', regex: /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/ },
  { id: 'windows-home-path', regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/ },
  { id: 'tilde-home-path', regex: /(?:^|[^A-Za-z0-9_-])~\/[A-Za-z0-9._/-]+/ },
  { id: 'drive-letter-path', regex: /\b[A-Z]:\/[A-Za-z0-9._/-]+/ },
  { id: 'unix-home-prefix', regex: /\b\/home\/[A-Za-z0-9._-]+(?:\/|$)/ },
  { id: 'tailnet-hostname', regex: /[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net/i },
  { id: 'rfc1918-ipv4', regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/ },
  { id: 'cgnat-ipv4', regex: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', regex: /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', regex: /\bxox[abpors]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { id: 'package-blueprint-path', regex: /\bpackage-blueprint\/[A-Za-z0-9._-]+/ },
  { id: 'openclaw-workspace-path', regex: /\.openclaw[\\/]workspace/ },
  { id: 'content-category-enumeration', regex: /\b(trading agents|hobby lore|intimacy lore|anime lore)\b/i },
];

const extra = (process.env.OPENCLAW_FRONTIER_DENY_TERMS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 50);
for (const term of extra) {
  if (term.length > 100) continue;
  PATTERNS.push({
    id: `operator-deny-term:${term.replace(/[^a-z0-9_-]/gi, '_')}`,
    regex: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  });
}

function scan(relPath, text) {
  const normalizedRel = relPath.replace(/\\/g, '/');
  if (SELF.test(normalizedRel)) return [];
  const findings = [];
  for (const pat of PATTERNS) {
    if (pat.allowFiles && pat.allowFiles.test(normalizedRel)) continue;
    const flags = pat.regex.flags.includes('g') ? pat.regex.flags : `${pat.regex.flags}g`;
    const rx = new RegExp(pat.regex.source, flags);
    let match;
    while ((match = rx.exec(text))) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ pattern: pat.id, file: normalizedRel, line, match: '[redacted]' });
    }
  }
  return findings;
}

module.exports = { PATTERNS, scan };
