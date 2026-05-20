#!/usr/bin/env node
'use strict';

// Render a per-release notes markdown file from CHANGELOG.md plus git stats.
//
// CLI:
//   node scripts/render-release-notes.js \
//     --version v0.8.0 \
//     --out release-gate/release-notes/v0.8.0.md \
//     [--prev v0.7.0] \
//     [--changelog CHANGELOG.md]
//
// Sources:
//   1. The matching CHANGELOG.md block whose header begins
//      `## YYYY-MM-DD — vX.Y.Z — ...`.
//   2. Git history between the previous tag and the target version
//      (commits, files changed, insertions).
//   3. Skill catalog delta — SKILL.md count at the target tree vs the
//      previous tag.
//
// Output sections (markdown):
//   - header
//   - summary (first paragraph of the CHANGELOG entry)
//   - stats (commits, insertions, files changed, new skills count)
//   - highlights (CHANGELOG `###` section headers)
//   - migration notes (if the entry has a `### Migration` or `## Migration` block)
//   - full changelog reference (path + anchor line)
//
// Testability:
//   Setting OPENCLAW_RELEASE_NOTES_GIT_FIXTURE=<path-to-json> short-circuits
//   every git invocation; the fixture file supplies { resolvedPrev, log,
//   skillCountPrev, skillCountTarget }. This lets the test harness exercise
//   the renderer without a real git tree.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEMA = 'openclaw-frontier.release-notes-render.v1';

function parseArgs(argv) {
  const out = { version: null, outPath: null, prev: null, changelog: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') { out.version = argv[i + 1]; i += 1; continue; }
    if (a === '--out') { out.outPath = argv[i + 1]; i += 1; continue; }
    if (a === '--prev') { out.prev = argv[i + 1]; i += 1; continue; }
    if (a === '--changelog') { out.changelog = argv[i + 1]; i += 1; continue; }
    if (a === '--root') { out.root = argv[i + 1]; i += 1; continue; }
    if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/render-release-notes.js --version vX.Y.Z --out <path>',
    '                                       [--prev vA.B.C]',
    '                                       [--changelog CHANGELOG.md]',
    '                                       [--root <repo-root>]',
    '',
    'Env:',
    '  OPENCLAW_RELEASE_NOTES_GIT_FIXTURE=<path>  read git data from JSON fixture',
  ].join('\n');
}

function normalizeVersion(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^v\d+\.\d+\.\d+/.test(s)) return null;
  return s;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadFixture() {
  const fxPath = process.env.OPENCLAW_RELEASE_NOTES_GIT_FIXTURE;
  if (!fxPath) return null;
  const raw = fs.readFileSync(fxPath, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    throw new Error('git fixture must be a JSON object');
  }
  return data;
}

function gitInvoke(args, opts) {
  const out = execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

function resolvePrevTag(root, target) {
  // Sort tags by version descending; first tag strictly less than target wins.
  const raw = gitInvoke(['tag', '-l', '--sort=-v:refname'], { cwd: root });
  const tags = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const targetIndex = tags.indexOf(target);
  if (targetIndex === -1) {
    // Fall back to the first tag that sorts strictly less than target.
    for (const t of tags) {
      if (compareVersions(t, target) < 0) return t;
    }
    return null;
  }
  for (let i = targetIndex + 1; i < tags.length; i += 1) {
    if (compareVersions(tags[i], target) < 0) return tags[i];
  }
  return null;
}

function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(s).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function readGitLogStats(root, prev, target) {
  if (!prev) {
    return { commits: [], totalCommits: 0, totalInsertions: 0, totalDeletions: 0, totalFilesChanged: 0 };
  }
  const raw = gitInvoke(['log', `${prev}..${target}`, '--shortstat', '--format=%H %s'], { cwd: root });
  return parseGitLogStats(raw);
}

function parseGitLogStats(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const commits = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  let totalFilesChanged = 0;
  let current = null;
  for (const line of lines) {
    const headerMatch = /^([0-9a-f]{7,40})\s+(.+)$/.exec(line);
    if (headerMatch) {
      if (current) commits.push(current);
      current = { sha: headerMatch[1], subject: headerMatch[2], filesChanged: 0, insertions: 0, deletions: 0 };
      continue;
    }
    if (current && /\bfile[s]?\s+changed\b/.test(line)) {
      const filesM = /(\d+)\s+files?\s+changed/.exec(line);
      const insM = /(\d+)\s+insertion/.exec(line);
      const delM = /(\d+)\s+deletion/.exec(line);
      if (filesM) current.filesChanged = Number(filesM[1]);
      if (insM) current.insertions = Number(insM[1]);
      if (delM) current.deletions = Number(delM[1]);
      totalFilesChanged += current.filesChanged;
      totalInsertions += current.insertions;
      totalDeletions += current.deletions;
    }
  }
  if (current) commits.push(current);
  return {
    commits,
    totalCommits: commits.length,
    totalInsertions,
    totalDeletions,
    totalFilesChanged,
  };
}

function countSkillsAtTag(root, ref) {
  if (!ref) return 0;
  let raw;
  try {
    raw = gitInvoke(['ls-tree', '-r', ref, '--', 'skills/'], { cwd: root });
  } catch {
    return 0;
  }
  return raw.split(/\r?\n/).filter((line) => /\/SKILL\.md$/.test(line.trim())).length;
}

function findChangelogBlock(text, version) {
  const headerRegex = new RegExp(`^## (\\d{4}-\\d{2}-\\d{2})\\s+[—-]\\s+${escapeRegex(version)}\\s+[—-]\\s+(.+)$`, 'm');
  const headerMatch = headerRegex.exec(text);
  if (!headerMatch) return null;
  const start = headerMatch.index;
  const headerLine = headerMatch[0];
  const date = headerMatch[1];
  const title = headerMatch[2].trim();
  // Find the next `## ` header after this block.
  const after = text.slice(start + headerLine.length);
  const nextHeader = /\n## /.exec(after);
  const blockBody = nextHeader ? after.slice(0, nextHeader.index) : after;
  return { date, title, headerLine, body: blockBody.replace(/^\n+/, '') };
}

function extractSummary(blockBody) {
  // First non-empty paragraph that is not a `### Status:` line and not a
  // sub-section header.
  const lines = blockBody.split(/\r?\n/);
  const out = [];
  let started = false;
  for (const line of lines) {
    if (!started) {
      if (line.trim() === '') continue;
      if (/^Status:/i.test(line.trim())) continue;
      if (/^#{2,}\s/.test(line)) continue;
      started = true;
    }
    if (started) {
      if (line.trim() === '') break;
      if (/^#{2,}\s/.test(line)) break;
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function extractSubHeaders(blockBody) {
  const headers = [];
  const re = /^###\s+(.+)$/gm;
  let m;
  while ((m = re.exec(blockBody))) {
    headers.push(m[1].trim());
  }
  return headers;
}

function extractMigrationBlock(blockBody) {
  const re = /^###\s+(Migration|Migration notes|Breaking changes)\b.*$/im;
  const m = re.exec(blockBody);
  if (!m) return null;
  const start = m.index;
  const after = blockBody.slice(start + m[0].length);
  const next = /^###\s+/m.exec(after);
  const body = next ? after.slice(0, next.index) : after;
  return body.trim();
}

function buildOutput(opts) {
  const { version, date, title, summary, headers, migration, stats, skills, prev, changelogRelPath } = opts;
  const lines = [];
  lines.push(`# Release notes — ${version}`);
  lines.push('');
  lines.push(`Date: ${date}`);
  lines.push(`Title: ${title}`);
  lines.push(`Previous tag: ${prev || '(none)'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summary || '(no summary paragraph in the CHANGELOG entry)');
  lines.push('');
  lines.push('## Stats');
  lines.push('');
  lines.push(`- Commits: ${stats.totalCommits}`);
  lines.push(`- Files changed: ${stats.totalFilesChanged}`);
  lines.push(`- Insertions: ${stats.totalInsertions}`);
  lines.push(`- Deletions: ${stats.totalDeletions}`);
  lines.push(`- Skill catalog: ${skills.prev} -> ${skills.target} (delta ${skills.target - skills.prev})`);
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  if (headers.length === 0) {
    lines.push('- (no `###` subsection headers in the CHANGELOG entry)');
  } else {
    for (const h of headers) lines.push(`- ${h}`);
  }
  lines.push('');
  if (migration) {
    lines.push('## Migration notes');
    lines.push('');
    lines.push(migration);
    lines.push('');
  }
  lines.push('## Full changelog');
  lines.push('');
  lines.push(`See the matching block in \`${changelogRelPath}\` under the heading:`);
  lines.push('');
  lines.push(`> ${date} — ${version} — ${title}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const version = normalizeVersion(args.version);
  if (!version) {
    process.stderr.write('error: --version vX.Y.Z is required\n' + usage() + '\n');
    return 2;
  }
  if (!args.outPath) {
    process.stderr.write('error: --out <path> is required\n' + usage() + '\n');
    return 2;
  }
  const root = args.root ? path.resolve(args.root) : path.resolve(__dirname, '..');
  const changelogRel = args.changelog || 'CHANGELOG.md';
  const changelogAbs = path.isAbsolute(changelogRel) ? changelogRel : path.join(root, changelogRel);
  if (!fs.existsSync(changelogAbs)) {
    process.stderr.write(`error: CHANGELOG not found at ${changelogAbs}\n`);
    return 2;
  }
  const changelogText = fs.readFileSync(changelogAbs, 'utf8');
  const block = findChangelogBlock(changelogText, version);
  if (!block) {
    process.stderr.write(`error: no CHANGELOG entry for ${version}\n`);
    return 2;
  }

  const fixture = loadFixture();

  let prev = args.prev || null;
  let stats;
  let skillsPrev;
  let skillsTarget;

  if (fixture) {
    prev = fixture.resolvedPrev !== undefined ? fixture.resolvedPrev : prev;
    stats = parseGitLogStats(fixture.log || '');
    skillsPrev = Number.isFinite(fixture.skillCountPrev) ? fixture.skillCountPrev : 0;
    skillsTarget = Number.isFinite(fixture.skillCountTarget) ? fixture.skillCountTarget : 0;
  } else {
    if (!prev) {
      try {
        prev = resolvePrevTag(root, version);
      } catch (err) {
        process.stderr.write(`warning: unable to resolve previous tag: ${err.message}\n`);
        prev = null;
      }
    }
    stats = readGitLogStats(root, prev, version);
    skillsPrev = countSkillsAtTag(root, prev);
    skillsTarget = countSkillsAtTag(root, version);
  }

  const summary = extractSummary(block.body);
  const headers = extractSubHeaders(block.body);
  const migration = extractMigrationBlock(block.body);

  const output = buildOutput({
    version,
    date: block.date,
    title: block.title,
    summary,
    headers,
    migration,
    stats,
    skills: { prev: skillsPrev, target: skillsTarget },
    prev,
    changelogRelPath: changelogRel,
  });

  const outAbs = path.isAbsolute(args.outPath) ? args.outPath : path.join(root, args.outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, output + '\n');

  process.stdout.write(JSON.stringify({
    schema: SCHEMA,
    ok: true,
    version,
    prev,
    out: path.relative(root, outAbs).replace(/\\/g, '/'),
    stats: {
      commits: stats.totalCommits,
      filesChanged: stats.totalFilesChanged,
      insertions: stats.totalInsertions,
      deletions: stats.totalDeletions,
    },
    skills: { prev: skillsPrev, target: skillsTarget },
    highlights: headers.length,
    hasMigration: Boolean(migration),
  }, null, 2) + '\n');
  return 0;
}

module.exports = {
  parseArgs,
  parseGitLogStats,
  findChangelogBlock,
  extractSummary,
  extractSubHeaders,
  extractMigrationBlock,
  buildOutput,
  resolvePrevTag,
  compareVersions,
  parseSemver,
  normalizeVersion,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`error: ${err.stack || err.message || err}\n`);
    process.exit(1);
  }
}
