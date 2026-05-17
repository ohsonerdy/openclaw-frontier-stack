#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const registryPath = path.join(root, 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
assert.strictEqual(registry.schema, 'openclaw-frontier.skill-registry.v1');
assert(registry.skills.length >= 1, 'registry should include at least one skill');

for (const skill of registry.skills) {
  const skillPath = path.join(root, skill.path);
  assert(fs.existsSync(skillPath), `missing skill path: ${skill.path}`);
  // Normalize line endings before frontmatter checks so CRLF checkouts (Windows
  // fresh clones with default core.autocrlf) verify the same as LF checkouts.
  const body = fs.readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  assert(body.startsWith('---\n'), `missing frontmatter: ${skill.path}`);
  const fmEnd = body.indexOf('\n---', 4);
  assert(fmEnd > 0, `unterminated frontmatter: ${skill.path}`);
  const frontmatter = body.slice(4, fmEnd);
  assert(
    new RegExp(`(^|\\n)name:\\s+${skill.name}(\\s|$)`).test(frontmatter),
    `frontmatter name mismatch: ${skill.path}`,
  );
  assert(/(^|\n)description:\s+\S.+/i.test(frontmatter), `missing description: ${skill.path}`);
}

const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skill-forge-demo-'));
const artifact = path.join(tmpDir, 'demo-artifact.txt');
fs.writeFileSync(artifact, 'Synthetic demo artifact for Skill Forge.\nNo private data.\n');
const script = path.join(root, 'demo-skills', 'inspect-artifact', 'scripts', 'inspect-artifact.js');
const output = JSON.parse(execFileSync(process.execPath, [script, artifact], { encoding: 'utf8' }));
assert.strictEqual(output.ok, true);
assert.strictEqual(output.bytes, fs.statSync(artifact).size);
assert(output.sha256 && output.sha256.length === 64);
assert(output.preview.includes('Synthetic demo artifact'));

console.log(JSON.stringify({ ok: true, skills: registry.skills.length, inspectedBytes: output.bytes }, null, 2));
