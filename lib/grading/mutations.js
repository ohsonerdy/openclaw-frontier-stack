'use strict';

/**
 * lib/grading/mutations.js — mutation catalog for the release-gate-strictness
 * grade category.
 *
 * Each mutation defines a temporary edit to the working tree designed to be
 * caught by `scripts/verify-package.js` (or one of its sub-verifiers). The
 * mutation runner applies the mutation, runs the verifier, then reverts.
 *
 * Contract for each mutation:
 *   - `id`           string, unique, kebab-case. Used as a CLI filter token.
 *   - `description`  short human prose. Operator-safe (no emojis).
 *   - `apply(root)`  performs the edit. Returns nothing. Throws on failure.
 *   - `revert(root)` restores the previous state. Idempotent — safe to call
 *                    even if `apply` was never invoked or already reverted.
 *
 * Implementation notes:
 *   - Mutations are written so that the SAME mutation can be applied/reverted
 *     repeatedly across a session. They snapshot the original file bytes
 *     (or absence) into a module-scoped map keyed by mutation id.
 *   - Mutations NEVER touch git. They only edit working-tree files. The
 *     runner takes a working-tree snapshot before/after the full sweep and
 *     panics if the tree is not byte-identical at the end.
 *   - File creation mutations are reverted by deleting the created file
 *     (only when we created it).
 *   - File deletion mutations save the original bytes and rewrite them on
 *     revert.
 */

const fs = require('fs');
const path = require('path');

const snapshots = new Map();

function snapshotKey(id, rel) {
  return `${id}::${rel}`;
}

function saveFile(id, root, rel) {
  const abs = path.join(root, rel);
  const key = snapshotKey(id, rel);
  if (snapshots.has(key)) return;
  if (fs.existsSync(abs)) {
    snapshots.set(key, { kind: 'existed', bytes: fs.readFileSync(abs) });
  } else {
    snapshots.set(key, { kind: 'absent' });
  }
}

function restoreFile(id, root, rel) {
  const abs = path.join(root, rel);
  const key = snapshotKey(id, rel);
  if (!snapshots.has(key)) return;
  const snap = snapshots.get(key);
  if (snap.kind === 'existed') {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, snap.bytes);
  } else {
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }
  snapshots.delete(key);
}

function saveTree(id, root, rel) {
  const abs = path.join(root, rel);
  const key = snapshotKey(id, rel);
  if (snapshots.has(key)) return;
  if (!fs.existsSync(abs)) {
    snapshots.set(key, { kind: 'absent-tree' });
    return;
  }
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    saveFile(id, root, rel);
    return;
  }
  const entries = [];
  walkForSnapshot(abs, abs, entries);
  snapshots.set(key, { kind: 'tree', entries });
}

function walkForSnapshot(base, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push({ kind: 'dir', rel });
      walkForSnapshot(base, full, out);
    } else if (entry.isFile()) {
      out.push({ kind: 'file', rel, bytes: fs.readFileSync(full) });
    }
  }
}

function restoreTree(id, root, rel) {
  const abs = path.join(root, rel);
  const key = snapshotKey(id, rel);
  if (!snapshots.has(key)) return;
  const snap = snapshots.get(key);
  if (snap.kind === 'absent-tree') {
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    snapshots.delete(key);
    return;
  }
  if (snap.kind === 'tree') {
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    fs.mkdirSync(abs, { recursive: true });
    for (const entry of snap.entries) {
      const full = path.join(abs, entry.rel);
      if (entry.kind === 'dir') fs.mkdirSync(full, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, entry.bytes);
      }
    }
    snapshots.delete(key);
    return;
  }
  // Single-file snapshot saved via saveFile.
  restoreFile(id, root, rel);
}

function patchJson(root, rel, mutator) {
  const abs = path.join(root, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const obj = JSON.parse(raw);
  mutator(obj);
  const out = JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : '');
  fs.writeFileSync(abs, out);
}

function writeRaw(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function appendLine(root, rel, line) {
  const abs = path.join(root, rel);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const sep = before.endsWith('\n') || before === '' ? '' : '\n';
  fs.writeFileSync(abs, `${before}${sep}${line}\n`);
}

const MUTATIONS = [
  {
    id: 'delete-incident-response-skill',
    description: 'Delete skills/incident-response/SKILL.md to trip the modern-skills validator.',
    apply(root) {
      saveFile(this.id, root, 'skills/incident-response/SKILL.md');
      fs.rmSync(path.join(root, 'skills/incident-response/SKILL.md'));
    },
    revert(root) {
      restoreFile(this.id, root, 'skills/incident-response/SKILL.md');
    },
  },
  {
    id: 'corrupt-claude-plugin-json',
    description: 'Insert garbage into .claude-plugin/plugin.json so the manifest no longer parses.',
    apply(root) {
      const rel = '.claude-plugin/plugin.json';
      saveFile(this.id, root, rel);
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      fs.writeFileSync(path.join(root, rel), `{ not valid json ${raw}`);
    },
    revert(root) {
      restoreFile(this.id, root, '.claude-plugin/plugin.json');
    },
  },
  {
    id: 'fake-package-version',
    description: 'Set package.json#version to a value that does not appear in CHANGELOG.md.',
    apply(root) {
      saveFile(this.id, root, 'package.json');
      patchJson(root, 'package.json', (obj) => {
        obj.version = '99.99.99';
      });
    },
    revert(root) {
      restoreFile(this.id, root, 'package.json');
    },
  },
  {
    id: 'duplicate-nested-contract',
    description: 'Add a nested agents/architect/architect/CONTRACT.md duplicate to flag tree-shape drift.',
    apply(root) {
      const rel = 'agents/architect/architect/CONTRACT.md';
      saveFile(this.id, root, rel);
      writeRaw(root, rel, '# duplicate nested contract\n');
    },
    revert(root) {
      restoreFile(this.id, root, 'agents/architect/architect/CONTRACT.md');
      const dir = path.join(root, 'agents/architect/architect');
      if (fs.existsSync(dir)) {
        const remaining = fs.readdirSync(dir);
        if (remaining.length === 0) fs.rmdirSync(dir);
      }
    },
  },
  {
    id: 'remove-bin-shebang',
    description: 'Remove the shebang line from bin/openclaw to break the missing-bin-target check.',
    apply(root) {
      const rel = 'bin/openclaw';
      saveFile(this.id, root, rel);
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      fs.writeFileSync(path.join(root, rel), text.replace(/^#!.*\r?\n/, ''));
    },
    revert(root) {
      restoreFile(this.id, root, 'bin/openclaw');
    },
  },
  {
    id: 'inject-email-into-readme',
    description: 'Insert an email-like token into README.md to trip the private-content scanner.',
    apply(root) {
      const rel = 'README.md';
      saveFile(this.id, root, rel);
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const at = String.fromCharCode(64);
      const localPart = ['mutation', 'probe', 'private', 'address'].join('-');
      const domain = ['example-mutation', 'invalid'].join('.');
      const probe = `${localPart}${at}${domain}`;
      fs.writeFileSync(path.join(root, rel), `${text}\n<!-- mutation probe ${probe} -->\n`);
    },
    revert(root) {
      restoreFile(this.id, root, 'README.md');
    },
  },
  {
    id: 'broken-smoke-script-target',
    description: 'Point package.json#scripts.smoke at a script path that does not exist.',
    apply(root) {
      saveFile(this.id, root, 'package.json');
      patchJson(root, 'package.json', (obj) => {
        if (!obj.scripts) obj.scripts = {};
        obj.scripts.smoke = 'node scripts/run-demos-MISSING.js';
      });
    },
    revert(root) {
      restoreFile(this.id, root, 'package.json');
    },
  },
  {
    id: 'missing-files-glob-entry',
    description: 'Add a nonexistent directory to package.json#files so missing-files-entry fires.',
    apply(root) {
      saveFile(this.id, root, 'package.json');
      patchJson(root, 'package.json', (obj) => {
        if (!Array.isArray(obj.files)) obj.files = [];
        obj.files.push('mutation-nonexistent-dir/');
      });
    },
    revert(root) {
      restoreFile(this.id, root, 'package.json');
    },
  },
  {
    id: 'delete-changelog-verifier',
    description: 'Delete release-gate/scripts/verify-changelog.js so the changelog-test sub-check fails.',
    apply(root) {
      saveFile(this.id, root, 'release-gate/scripts/verify-changelog.js');
      fs.rmSync(path.join(root, 'release-gate/scripts/verify-changelog.js'));
    },
    revert(root) {
      restoreFile(this.id, root, 'release-gate/scripts/verify-changelog.js');
    },
  },
  {
    id: 'inject-coauthor-trailer-into-doc',
    description: 'Insert a co-author trailer into a docs file. The public-surface harness rejects this token on the public surface.',
    apply(root) {
      const rel = 'docs/release-scope.md';
      saveFile(this.id, root, rel);
      const header = ['Co', 'authored', 'by'].join('-');
      const localPart = ['probe', 'mutation'].join('-');
      const domain = ['example', 'invalid'].join('.');
      appendLine(root, rel, `${header}: probe <${localPart}@${domain}>`);
    },
    revert(root) {
      restoreFile(this.id, root, 'docs/release-scope.md');
    },
  },
  {
    id: 'inject-anthropic-key-pattern',
    description: 'Insert a string matching the Anthropic-key pattern into a docs file.',
    apply(root) {
      const rel = 'docs/release-scope.md';
      saveFile(this.id, root, rel);
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const probe = ['sk', 'ant', '1234567890abcdef1234567890abcdef1234'].join('-');
      fs.writeFileSync(path.join(root, rel), `${text}\n<!-- mutation probe ${probe} -->\n`);
    },
    revert(root) {
      restoreFile(this.id, root, 'docs/release-scope.md');
    },
  },
  {
    id: 'sentinel-contract-bad-path',
    description: 'Append a backticked path to security-sentinel CONTRACT.md that does not exist on disk.',
    apply(root) {
      const rel = 'agents/security-sentinel/CONTRACT.md';
      saveFile(this.id, root, rel);
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const inject = '\n\n## Decision authority\n\n- Can: write `release-gate/mutation-probe-not-real/sentinel-trip.json` on demand.\n';
      fs.writeFileSync(path.join(root, rel), text + inject);
    },
    revert(root) {
      restoreFile(this.id, root, 'agents/security-sentinel/CONTRACT.md');
    },
  },
  {
    id: 'corrupt-skill-evals-json',
    description: 'Set skills/incident-response/evals/evals.json to invalid JSON.',
    apply(root) {
      const rel = 'skills/incident-response/evals/evals.json';
      saveFile(this.id, root, rel);
      fs.writeFileSync(path.join(root, rel), '{not valid json');
    },
    revert(root) {
      restoreFile(this.id, root, 'skills/incident-response/evals/evals.json');
    },
  },
  {
    id: 'remove-envelope-cargo-toml',
    description: 'Delete crates/openclaw-envelope/Cargo.toml — a load-bearing manifest in the Rust workspace.',
    apply(root) {
      const rel = 'crates/openclaw-envelope/Cargo.toml';
      saveFile(this.id, root, rel);
      fs.rmSync(path.join(root, rel));
    },
    revert(root) {
      restoreFile(this.id, root, 'crates/openclaw-envelope/Cargo.toml');
    },
  },
  {
    id: 'semver-mismatch-codex-plugin',
    description: 'Set .codex-plugin/plugin.json#version to 0.0.0 to trip the semver-consistency check.',
    apply(root) {
      saveFile(this.id, root, '.codex-plugin/plugin.json');
      patchJson(root, '.codex-plugin/plugin.json', (obj) => {
        obj.version = '0.0.0';
      });
    },
    revert(root) {
      restoreFile(this.id, root, '.codex-plugin/plugin.json');
    },
  },
  {
    id: 'inject-tilde-home-path-into-doc',
    description: 'Insert a tilde-home path into a docs file to trip the private-content scanner.',
    apply(root) {
      const rel = 'docs/release-scope.md';
      saveFile(this.id, root, rel);
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      const probe = String.fromCharCode(126) + '/mutation/probe/path';
      fs.writeFileSync(path.join(root, rel), `${text}\nProbe: ${probe}\n`);
    },
    revert(root) {
      restoreFile(this.id, root, 'docs/release-scope.md');
    },
  },
  {
    id: 'corrupt-bundles-json',
    description: 'Set bundles.json to invalid JSON to trip downstream parse checks.',
    apply(root) {
      const rel = 'bundles.json';
      saveFile(this.id, root, rel);
      fs.writeFileSync(path.join(root, rel), '{not valid');
    },
    revert(root) {
      restoreFile(this.id, root, 'bundles.json');
    },
  },
];

const __testHelpers = {
  snapshots,
  saveFile,
  restoreFile,
  saveTree,
  restoreTree,
};

module.exports = { MUTATIONS, __testHelpers };
