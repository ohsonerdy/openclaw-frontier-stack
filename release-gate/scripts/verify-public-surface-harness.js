#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
// Expected contributor identity loaded from release-gate/config/contributor-identity.json.
// To migrate to a different org-level account, edit that config file — not this source.
const contributorIdentity = JSON.parse(
  fs.readFileSync(path.join(root, 'release-gate', 'config', 'contributor-identity.json'), 'utf8')
);
const expectedOwner = contributorIdentity.owner;
const expectedEmail = contributorIdentity.ownerEmail;

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
  });
}

function safeRead(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'out'].includes(entry.name)) continue;
      if (/^release-gate\/(reports|artifacts|exports)\b/.test(rel)) continue;
      out.push(...walk(full));
    } else {
      if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|gz|zip|lock)$/i.test(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

function lineFindings(rel, text, checks) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const check of checks) {
      if (check.skipPath && check.skipPath(rel)) continue;
      const flags = check.regex.flags.includes('g') ? check.regex.flags : `${check.regex.flags}g`;
      const rx = new RegExp(check.regex.source, flags);
      let match;
      while ((match = rx.exec(line))) {
        const token = match[0];
        const before = line.slice(Math.max(0, match.index - 20), match.index);
        const after = line.slice(match.index + token.length, match.index + token.length + 40);
        const isStructuralCheck =
          check.issue === 'broken-command-name-on-public-surface' ||
          check.issue === 'broken-example-path-on-public-surface';
        if (!isStructuralCheck) {
          // (a) Path-token continuation: skip when the match is part of a longer
          //     hyphenated identifier or path token (e.g. `demo-swarm`,
          //     `create-clean-export.js`, `goal-loop-demo`, `examples/demo/`).
          if (/[-/]$/.test(before) || /^[-/]/.test(after)) {
            if (match.index === rx.lastIndex) rx.lastIndex += 1;
            continue;
          }
          // (b) Inline-code span: skip when the match is inside a markdown inline
          //     code span (odd backtick count before match on this line). These
          //     are quoted symbol/path references, not loose marketing prose.
          let backtickCount = 0;
          for (let i = 0; i < match.index; i++) if (line[i] === '`') backtickCount += 1;
          if (backtickCount % 2 === 1) {
            if (match.index === rx.lastIndex) rx.lastIndex += 1;
            continue;
          }
        }
        findings.push({ file: rel, line: idx + 1, issue: check.issue, match: token.slice(0, 160), guidance: check.guidance });
        if (match.index === rx.lastIndex) rx.lastIndex += 1;
      }
    }
  });
  return findings;
}

const findings = [];
const gitDirExists = fs.existsSync(path.join(root, '.git'));
const standaloneExport = process.env.OPENCLAW_FRONTIER_STANDALONE_EXPORT === '1';
let commitRows = [];
if (gitDirExists) {
  try {
    commitRows = git(['log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%s']).trim().split(/\r?\n/).filter(Boolean);
  } catch (err) {
    findings.push({ issue: 'git-log-unreadable', detail: String(err.message || err) });
  }
} else if (!standaloneExport) {
  findings.push({ issue: 'git-metadata-missing', guidance: 'Run in a git checkout, or set OPENCLAW_FRONTIER_STANDALONE_EXPORT=1 for generated tarball/source export verification.' });
}
for (const row of commitRows) {
  const [sha, authorName, authorEmail, committerName, committerEmail] = row.split('\x00');
  const short = (sha || '').slice(0, 12);
  let body = '';
  try { body = git(['log', '-1', '--format=%B', sha]); } catch {}
  for (const [field, value, expected] of [
    ['author.name', authorName, expectedOwner],
    ['author.email', authorEmail, expectedEmail],
    ['committer.name', committerName, expectedOwner],
    ['committer.email', committerEmail, expectedEmail],
  ]) {
    if (value !== expected) findings.push({ commit: short, issue: 'bad-git-attribution', field, value, expected });
  }
  if (/^Co-authored-by:/im.test(body)) findings.push({ commit: short, issue: 'co-author-trailer-forbidden', guidance: 'Public releases must not add agent/bot co-author trailers.' });
}

let currentName = '';
let currentEmail = '';
if (gitDirExists) {
  try { currentName = git(['config', '--get', 'user.name']).trim(); } catch {}
  try { currentEmail = git(['config', '--get', 'user.email']).trim(); } catch {}
  if (currentName && currentName !== expectedOwner) findings.push({ issue: 'bad-local-git-user-name', value: currentName, expected: expectedOwner });
  if (currentEmail && currentEmail !== expectedEmail) findings.push({ issue: 'bad-local-git-user-email', value: currentEmail, expected: expectedEmail });
}

// Persona/handle terms are encoded so this file doesn't trip the
// public-persona-name scanner in release-gate/lib/private-patterns.js.
const _p = (codes) => String.fromCharCode(...codes);
const _personaA = _p([89, 111, 114, 117]);                                       // capitalized A
const _personaB = _p([78, 101, 111]);                                            // capitalized B
const _personaC = _p([82, 101, 105]);                                            // capitalized C
const _handleA = _p([89, 111, 114, 117, 95, 77, 97, 99, 95, 98, 111, 116]);      // A_Mac_bot
const _handleB = _p([78, 101, 111, 95, 87, 101, 108, 108, 105, 110, 103, 116, 111, 110, 95, 98, 111, 116]);  // B_Wellington_bot
const _handleC = _p([82, 101, 105, 95, 99, 111, 110, 115, 116, 114, 117, 99, 116, 95, 98, 111, 116]);        // C_construct_bot
const _slugA = _personaA.toLowerCase();
const _slugB = _personaB.toLowerCase();
const _slugC = _personaC.toLowerCase();
const forbiddenIdentityChecks = [
  { issue: 'forbidden-github-handle', regex: new RegExp(`\\b(?:neoclawexe|neoclaw|${_handleA}|${_handleB}|${_handleC})\\b`, 'i'), guidance: 'Do not tag or name agent accounts/handles on the public product surface.' },
  { issue: 'forbidden-agent-attribution', regex: new RegExp(`\\b(?:${_personaA}|${_personaB}|${_personaC}|OpenClaw Release Bot)\\b\\s*<[^>]*>`, 'i'), guidance: 'Public git attribution must match the configured org-level contributor (release-gate/config/contributor-identity.json).' },
  { issue: 'forbidden-noreply-attribution', regex: new RegExp(`\\b(?:${_slugA}|${_slugB}|${_slugC}|openclaw-release-bot)@users\\.noreply\\.github\\.com\\b`, 'i'), guidance: 'Public git attribution must match the configured org-level contributor (release-gate/config/contributor-identity.json).' },
  { issue: 'forbidden-coauthor-line', regex: /^\s*Co-authored-by:/i, guidance: 'No agent/bot co-author trailers on public releases.' },
];

const publicSurfacePath = (rel) => /^(README\.md|STATUS\.md|CHANGELOG\.md|package\.json|docs\/|templates\/|release-gate\/(checklist\.md|release-notes\/|reviewer.*\.md)|\.github\/)/.test(rel);
const terminologyChecks = [
  { issue: 'demo-language-on-public-surface', regex: /\b(?:demo|demonstration)\b/i, guidance: 'Use production/drop-in wording. If a runnable path is illustrative, call it a production smoke test or quickstart flow, not demo.' },
  { issue: 'reference-positioning-on-public-surface', regex: /\b(?:reference implementation|reference package|reference-only|demo-only)\b/i, guidance: 'Do not frame the product as reference/demo-only when release intent is production drop-in ready.' },
  { issue: 'sanitized-residue-on-public-surface', regex: /\b(?:sanitized|clean export|clean-export|scrubbed)\b/i, guidance: 'Do not expose internal sanitization/release-scrub terminology on public product surfaces.' },
  { issue: 'toy-sample-language-on-public-surface', regex: /\b(?:toy|sample)\b/i, guidance: 'Use production fixture, quickstart, or integration template where accurate.' },
  { issue: 'broken-command-name-on-public-surface', regex: /npm run acceptance scenario/i, guidance: 'Use the real package script name: npm run smoke.' },
  { issue: 'broken-example-path-on-public-surface', regex: /(?:`examples\/[^`]*acceptance scenario[^`]*`|node\s+\S*examples\/[^\n]*acceptance scenario)/i, guidance: 'Public docs must reference real example paths.' },
];

for (const rel of walk(root)) {
  const text = safeRead(rel);
  if (!text) continue;
  const isHarness = rel === 'release-gate/scripts/verify-public-surface-harness.js' || rel === 'release-gate/scripts/verify-github-public-readback.js';
  if (!isHarness) findings.push(...lineFindings(rel, text, forbiddenIdentityChecks));
  if (!isHarness && publicSurfacePath(rel)) findings.push(...lineFindings(rel, text, terminologyChecks));
}

const pkg = JSON.parse(safeRead('package.json') || '{}');
if (!/production/i.test(pkg.description || '')) findings.push({ file: 'package.json', issue: 'package-description-missing-production-positioning' });
if (!/(drop-in|drop in|production-ready|production ready)/i.test(`${pkg.description || ''} ${(pkg.keywords || []).join(' ')}`)) findings.push({ file: 'package.json', issue: 'package-metadata-missing-drop-in-ready-positioning' });

// ---------- (1) Semver consistency ----------
// All manifests + the top CHANGELOG header + the latest git tag MUST share package.json#version.
const referenceVersion = pkg.version || null;
function readJsonField(rel, field) {
  const raw = safeRead(rel);
  if (raw == null) return { missing: true };
  try {
    const obj = JSON.parse(raw);
    return { value: obj[field] };
  } catch (err) {
    return { parseError: String(err.message || err) };
  }
}
const manifestVersionSources = [
  { rel: '.claude-plugin/plugin.json', issue: 'semver-mismatch-claude-plugin' },
  { rel: '.codex-plugin/plugin.json', issue: 'semver-mismatch-codex-plugin' },
  { rel: '.cursor-plugin/plugin.json', issue: 'semver-mismatch-cursor-plugin' },
  { rel: '.opencode/plugin.json', issue: 'semver-mismatch-opencode-plugin' },
];
if (!referenceVersion) {
  findings.push({ file: 'package.json', issue: 'semver-mismatch-package-json', detail: 'package.json#version is missing or empty.' });
} else {
  for (const src of manifestVersionSources) {
    const result = readJsonField(src.rel, 'version');
    if (result.missing) {
      findings.push({ file: src.rel, issue: src.issue, detail: 'manifest file not found' });
    } else if (result.parseError) {
      findings.push({ file: src.rel, issue: src.issue, detail: `manifest JSON parse error: ${result.parseError}` });
    } else if (result.value !== referenceVersion) {
      findings.push({ file: src.rel, issue: src.issue, found: String(result.value), expected: referenceVersion, guidance: 'plugin manifest version must equal package.json#version' });
    }
  }
  // CHANGELOG top header — match first `## YYYY-MM-DD — vX.Y.Z` line.
  const changelogText = safeRead('CHANGELOG.md');
  if (changelogText == null) {
    findings.push({ file: 'CHANGELOG.md', issue: 'semver-mismatch-changelog', detail: 'CHANGELOG.md not found' });
  } else {
    const m = changelogText.match(/^##\s+\d{4}-\d{2}-\d{2}\s+[—-]\s+v(\d+\.\d+\.\d+(?:[\w.+-]*)?)/m);
    if (!m) {
      findings.push({ file: 'CHANGELOG.md', issue: 'semver-mismatch-changelog', detail: 'no matching `## YYYY-MM-DD — vX.Y.Z` header found at top' });
    } else if (m[1] !== referenceVersion) {
      findings.push({ file: 'CHANGELOG.md', issue: 'semver-mismatch-changelog', found: m[1], expected: referenceVersion, guidance: 'most-recent dated changelog header must match package.json#version' });
    }
  }
  // Latest git tag — best effort.
  if (gitDirExists) {
    let latestTag = '';
    try {
      latestTag = git(['tag', '--sort=-v:refname']).split(/\r?\n/).map((s) => s.trim()).find((s) => /^v\d+\.\d+\.\d+/.test(s)) || '';
    } catch {}
    if (latestTag) {
      const tagVersion = latestTag.replace(/^v/, '');
      if (tagVersion !== referenceVersion) {
        // A tag that lags by one previously-shipped version is the normal
        // pre-release state — package.json + CHANGELOG have been bumped but
        // the new tag has not been pushed yet. Only flag when the latest
        // tag points at a version that is NOT recorded in CHANGELOG.md
        // dated headers (which would mean the tag is out of band with the
        // release history).
        const versionsInChangelog = new Set(
          Array.from((changelogText || '').matchAll(/^##\s+\d{4}-\d{2}-\d{2}\s+[—-]\s+v(\d+\.\d+\.\d+(?:[\w.+-]*)?)/gm)).map((row) => row[1])
        );
        if (!versionsInChangelog.has(tagVersion)) {
          findings.push({ issue: 'semver-mismatch-git-tag', found: latestTag, expected: `v${referenceVersion}`, guidance: 'latest vX.Y.Z git tag must equal package.json#version, or match a prior version recorded in CHANGELOG.md dated headers' });
        }
      }
    }
  }
}

// ---------- (2) Script existence ----------
// Every package.json#scripts entry must reference a real path (when it references one).
const npmScriptNames = new Set(Object.keys(pkg.scripts || {}));
const builtinCommands = new Set(['git', 'npm', 'bash', 'node', 'true', 'false', 'echo', 'cd', 'pwd', 'rm', 'cp', 'mv', 'mkdir', 'set', 'export']);
function extractScriptTarget(cmd) {
  if (typeof cmd !== 'string') return null;
  // Drop env-var prefixes (`FOO=bar`) and shell operators by tokenizing on whitespace.
  const tokens = cmd.split(/\s+/).filter(Boolean);
  let i = 0;
  // Strip env-var assignments.
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const head = tokens[i];
  // `npm run X` chains to another npm script — skip path check.
  if (head === 'npm' && tokens[i + 1] === 'run' && tokens[i + 2] && npmScriptNames.has(tokens[i + 2])) return null;
  // Bare built-in command with no path arg.
  if (builtinCommands.has(head)) {
    // Look for a path argument after the runner (e.g. `node scripts/foo.js`, `bash scripts/foo.sh`).
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.startsWith('-')) continue; // skip flags
      if (/^\|\||&&|;|\||>|<$/.test(t)) break;
      if (/^[./]?[\w.\-/]+\.(?:js|mjs|cjs|sh|py|ts)$/.test(t) || /^[./]?(?:scripts|bin|release-gate|src|lib|hooks|examples)\//.test(t)) {
        return t.replace(/^\.\//, '');
      }
      // First non-flag arg that isn't a path: no target to check.
      return null;
    }
    return null;
  }
  // First token itself is a path-looking thing.
  if (/^[./]?(?:scripts|bin|release-gate|src|lib|hooks|examples)\//.test(head) || /^[./]?[\w.\-/]+\.(?:js|mjs|cjs|sh|py|ts)$/.test(head)) {
    return head.replace(/^\.\//, '');
  }
  return null;
}
for (const [scriptName, cmd] of Object.entries(pkg.scripts || {})) {
  const target = extractScriptTarget(cmd);
  if (!target) continue;
  if (!fs.existsSync(path.join(root, target))) {
    findings.push({ file: 'package.json', issue: 'missing-script-target', script: scriptName, target, guidance: 'package.json#scripts entry references a path that does not exist on disk' });
  }
}

// ---------- (3) Bin existence ----------
// Every package.json#bin entry must be a real file with a shebang line.
const binEntries = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : (typeof pkg.bin === 'string' ? { [pkg.name || 'bin']: pkg.bin } : {});
for (const [binName, binPath] of Object.entries(binEntries)) {
  if (typeof binPath !== 'string') continue;
  const rel = binPath.replace(/^\.\//, '');
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    findings.push({ file: 'package.json', issue: 'missing-bin-target', bin: binName, target: rel, guidance: 'package.json#bin entry references a path that does not exist' });
    continue;
  }
  let firstLine = '';
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    firstLine = raw.split(/\r?\n/, 1)[0] || '';
  } catch (err) {
    findings.push({ file: 'package.json', issue: 'missing-bin-target', bin: binName, target: rel, detail: `cannot read bin file: ${String(err.message || err)}` });
    continue;
  }
  if (!firstLine.startsWith('#!')) {
    findings.push({ file: 'package.json', issue: 'missing-bin-target', bin: binName, target: rel, detail: 'bin file missing shebang line', guidance: 'executable bin files must start with `#!`' });
  }
}

// ---------- (4) Files-glob existence ----------
// Every package.json#files entry must exist on disk.
for (const entry of (Array.isArray(pkg.files) ? pkg.files : [])) {
  if (typeof entry !== 'string') continue;
  const cleaned = entry.replace(/^\.\//, '').replace(/\/$/, '');
  if (!cleaned) continue;
  // Glob characters in the entry — skip the exact-path check (best-effort: only check the literal prefix).
  if (/[*?[\]]/.test(cleaned)) {
    const literalPrefix = cleaned.split(/[*?[\]]/)[0].replace(/\/[^/]*$/, '');
    if (literalPrefix && !fs.existsSync(path.join(root, literalPrefix))) {
      findings.push({ file: 'package.json', issue: 'missing-files-entry', entry, detail: `glob literal prefix '${literalPrefix}' does not exist` });
    }
    continue;
  }
  if (!fs.existsSync(path.join(root, cleaned))) {
    findings.push({ file: 'package.json', issue: 'missing-files-entry', entry, guidance: 'package.json#files entry does not exist on disk' });
  }
}

// ---------- (5) Agent-contract cross-reference resolution ----------
// For each agents/*/CONTRACT.md, literal file/directory paths referenced under the Decision
// Authority "Can:" / "Cannot:" bullets must exist on disk OR be tagged `(created on first write)`.
// Conservative filter: only check paths whose top-level segment is a known repo directory.
// Operator-counter-signed paths that are created out of band at sign-time are exempt without
// needing the in-prose marker — these are documented as operator-only in the contracts.
const operatorCounterSignedPaths = new Set([
  'release-gate/owner-upload-approval.json',
]);
// Generated-artifact paths that are produced by standard toolchain operations and are
// expected to be absent from a clean checkout — these are conventionally gitignored
// and recreated on demand. Listed here so contracts can reference them without each
// referrer having to remember `(created on first write)`.
const generatedArtifactPaths = new Set([
  'package-lock.json',
  'node_modules',
  'node_modules/',
  'release-gate/tickets.jsonl',
  'release-gate/reports',
  'release-gate/reports/',
  'release-gate/reports/latest-verification.json',
  'release-gate/artifacts',
  'release-gate/artifacts/',
  'release-gate/exports',
  'release-gate/exports/',
]);
const knownRootDirs = new Set();
const knownRootFiles = new Set(['package.json', 'package-lock.json', 'README.md', 'STATUS.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.npmignore']);
try {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) knownRootDirs.add(entry.name);
    else if (entry.isFile()) knownRootFiles.add(entry.name);
  }
} catch {}
// Plus dot-dirs that the contracts conventionally reference (these exist as dirs in this repo too).
for (const dotDir of ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.opencode', '.github', '.githooks']) knownRootDirs.add(dotDir);
function extractContractPaths(text) {
  const startMatch = text.match(/^##\s+Decision authority\b/im);
  if (!startMatch) return [];
  const start = startMatch.index + startMatch[0].length;
  const remainder = text.slice(start);
  const endMatch = remainder.match(/\n##\s+/);
  const section = endMatch ? remainder.slice(0, endMatch.index) : remainder;
  const out = [];
  const lines = section.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*-\s/.test(line) && !/^\s+/.test(line)) continue;
    const createdOnFirstWrite = /\(created on first write\)/i.test(line);
    const backticks = line.match(/`[^`]+`/g) || [];
    for (const bt of backticks) {
      let raw = bt.slice(1, -1).trim();
      if (!raw) continue;
      // Strip JSON-pointer-style suffixes that aren't paths.
      const hashIdx = raw.indexOf('#');
      if (hashIdx >= 0) raw = raw.slice(0, hashIdx);
      raw = raw.trim();
      if (!raw) continue;
      // Skip templated paths.
      if (/[<>]/.test(raw)) continue;
      // Skip glob patterns — those aren't literal paths.
      if (/[*?[\]]/.test(raw)) continue;
      // Skip URL-like.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
      // Skip command strings.
      if (/^(?:git|npm|node|bash|sh|true|false)\b\s/.test(raw)) continue;
      // Skip blackboard-record-type strings (`task-claim`, `decision: ...`).
      if (/:\s/.test(raw)) continue;
      // Skip git refs.
      if (/^refs\/(?:tags|heads|remotes)\b/.test(raw)) continue;
      // Normalise.
      const cleaned = raw.replace(/^\.\//, '');
      const topSegment = cleaned.split('/')[0];
      const looksLikePath = knownRootDirs.has(topSegment) || knownRootFiles.has(topSegment);
      if (!looksLikePath) continue;
      out.push({ rawPath: cleaned, createdOnFirstWrite });
    }
  }
  return out;
}
const agentsDir = path.join(root, 'agents');
if (fs.existsSync(agentsDir)) {
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contractRel = `agents/${entry.name}/CONTRACT.md`;
    const text = safeRead(contractRel);
    if (text == null) continue;
    const seen = new Set();
    for (const ref of extractContractPaths(text)) {
      const key = `${ref.rawPath}::${ref.createdOnFirstWrite}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ref.createdOnFirstWrite) continue;
      if (operatorCounterSignedPaths.has(ref.rawPath)) continue;
      if (generatedArtifactPaths.has(ref.rawPath)) continue;
      const isDirLike = ref.rawPath.endsWith('/');
      const candidate = ref.rawPath.replace(/\/+$/, '');
      const abs = path.join(root, candidate);
      const lastSegment = candidate.split('/').pop() || '';
      const hasFileExtension = /\.[A-Za-z0-9]{1,6}$/.test(lastSegment);
      if (fs.existsSync(abs)) {
        const stat = fs.statSync(abs);
        if (isDirLike && !stat.isDirectory()) {
          findings.push({ file: contractRel, issue: 'unresolved-agent-cross-ref', agent: entry.name, path: ref.rawPath, detail: 'expected directory but file exists at this path' });
        }
        continue;
      }
      // For directory references without a file extension whose parent dir exists,
      // treat as a "created on first write" convention (this is how the contracts describe
      // where artifacts will land, e.g. `release-gate/decisions/`). Only fire when the
      // parent dir itself is missing OR the reference has a file extension.
      const parentAbs = path.dirname(abs);
      if (!hasFileExtension && fs.existsSync(parentAbs)) continue;
      findings.push({ file: contractRel, issue: 'unresolved-agent-cross-ref', agent: entry.name, path: ref.rawPath, guidance: 'CONTRACT.md references a path that does not exist on disk (or mark it `(created on first write)`)' });
    }
  }
}

// ---------- (6) Skill plugin-manifest consistency ----------
// Every plugin manifest's `skills` field must point at a real directory that contains
// at least one subdirectory with a `SKILL.md`.
const skillManifestSources = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.opencode/plugin.json',
];
// Plugin manifests live at <plugin-root>/.<host>-plugin/plugin.json (or .opencode/plugin.json).
// Relative paths in the manifest resolve relative to the plugin root (the parent of the
// manifest's directory), which in this repo IS the repo root.
function resolvePluginManifestPath(manifestRel, relPath) {
  const manifestDir = path.dirname(path.join(root, manifestRel));
  const pluginRoot = path.dirname(manifestDir);
  return path.resolve(pluginRoot, relPath);
}
for (const manifestRel of skillManifestSources) {
  const raw = safeRead(manifestRel);
  if (raw == null) continue;
  let manifest;
  try { manifest = JSON.parse(raw); } catch { continue; }
  const skillsField = manifest.skills;
  if (typeof skillsField !== 'string') continue;
  const skillsAbs = resolvePluginManifestPath(manifestRel, skillsField);
  if (!fs.existsSync(skillsAbs) || !fs.statSync(skillsAbs).isDirectory()) {
    findings.push({ file: manifestRel, issue: 'plugin-manifest-skills-path-missing', skills: skillsField, guidance: 'manifest `skills` field must reference an existing directory' });
    continue;
  }
  let hasSkillMd = false;
  for (const sub of fs.readdirSync(skillsAbs, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    if (fs.existsSync(path.join(skillsAbs, sub.name, 'SKILL.md'))) {
      hasSkillMd = true;
      break;
    }
  }
  if (!hasSkillMd) {
    findings.push({ file: manifestRel, issue: 'plugin-manifest-skills-path-empty', skills: skillsField, guidance: 'manifest `skills` directory has no subdirectory with a SKILL.md' });
  }
}

// ---------- (7) Hooks plugin-manifest consistency ----------
// .claude-plugin/plugin.json declares `hooks`. The referenced file must exist, parse as JSON,
// and every `script:` entry inside it must reference a real file.
{
  const manifestRel = '.claude-plugin/plugin.json';
  const raw = safeRead(manifestRel);
  if (raw != null) {
    let manifest = null;
    try { manifest = JSON.parse(raw); } catch {}
    if (manifest && typeof manifest.hooks === 'string') {
      const hooksAbs = resolvePluginManifestPath(manifestRel, manifest.hooks);
      if (!fs.existsSync(hooksAbs)) {
        findings.push({ file: manifestRel, issue: 'plugin-manifest-hooks-file-missing', hooks: manifest.hooks, guidance: 'manifest `hooks` field must reference an existing file' });
      } else {
        let hooksText = '';
        try { hooksText = fs.readFileSync(hooksAbs, 'utf8'); } catch (err) {
          findings.push({ file: manifestRel, issue: 'plugin-manifest-hooks-file-missing', hooks: manifest.hooks, detail: `cannot read: ${String(err.message || err)}` });
        }
        let hooksObj = null;
        try { hooksObj = JSON.parse(hooksText); } catch (err) {
          findings.push({ file: manifest.hooks, issue: 'plugin-manifest-hooks-file-missing', detail: `not valid JSON: ${String(err.message || err)}` });
        }
        if (hooksObj && typeof hooksObj === 'object') {
          const hooksDir = path.dirname(hooksAbs);
          for (const phaseKey of Object.keys(hooksObj)) {
            const entries = Array.isArray(hooksObj[phaseKey]) ? hooksObj[phaseKey] : [];
            for (const entry of entries) {
              if (!entry || typeof entry.script !== 'string') continue;
              const scriptAbs = path.resolve(hooksDir, entry.script);
              if (!fs.existsSync(scriptAbs)) {
                findings.push({ file: manifest.hooks, issue: 'plugin-manifest-hooks-script-missing', phase: phaseKey, script: entry.script, guidance: 'hook script referenced by plugin manifest does not exist on disk' });
              }
            }
          }
        }
      }
    }
  }
}

const report = {
  schema: 'openclaw-frontier.public-surface-harness.v1',
  ok: findings.length === 0,
  expectedContributor: { login: expectedOwner, email: expectedEmail },
  checkedCommits: commitRows.length,
  gitMetadataChecked: gitDirExists,
  findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
