#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan } = require('../release-gate/lib/private-patterns');

const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'release-gate', 'reports');
fs.mkdirSync(reportDir, { recursive: true });

const DEFAULT_CHILD_TIMEOUT_MS = Number.parseInt(process.env.FRONTIER_CHILD_TIMEOUT_MS || '120000', 10);

function run(name, cmd, args, opts = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      encoding: 'utf8',
      timeout: opts.timeout || DEFAULT_CHILD_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { name, ok: true, ms: Date.now() - started, stdout: stdout.trim() };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(err.message || err),
      stdout: err.stdout ? String(err.stdout).trim() : '',
      stderr: err.stderr ? String(err.stderr).trim() : '',
    };
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'out'].includes(entry.name)) continue;
      if (rel === 'release-gate/reports' || rel === 'release-gate/artifacts') continue;
      out.push(...walk(full));
    } else {
      out.push({ full, rel });
    }
  }
  return out;
}

function scanPrivateContent() {
  const findings = [];
  for (const file of walk(root)) {
    let text;
    try { text = decodePublicTextFile(file, findings); } catch { continue; }
    if (!text) continue;
    findings.push(...scan(file.rel, text));
  }
  return { name: 'private-content-scan', ok: findings.length === 0, findings };
}

function decodePublicTextFile(file, findings) {
  const buf = fs.readFileSync(file.full);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    findings.push({ pattern: 'non-utf8-text-encoding', file: file.rel, line: 1, match: 'UTF-16 BOM' });
    return '';
  }
  const isLikelyText = /\.(md|js|json|yaml|yml|txt|env|example|template|sh)$/i.test(file.rel);
  if (isLikelyText && buf.indexOf(0) !== -1) {
    findings.push({ pattern: 'nul-byte-in-text-file', file: file.rel, line: 1, match: '\\0 byte present' });
    return '';
  }
  return buf.toString('utf8');
}

function removeGeneratedDemoOutputs() {
  for (const rel of ['examples/demo-swarm/out', 'examples/memory-demo/out', 'examples/goal-loop-demo/out']) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
}

const checks = [];
checks.push(run('signed-bus-envelope-test', process.execPath, [path.join(root, 'src', 'signed-bus', 'test', 'envelope-local.test.js')]));
checks.push(run('signed-bus-h2-regression-test', process.execPath, [path.join(root, 'src', 'signed-bus', 'test', 'nested-signature-tamper.test.js')]));
checks.push(run('modern-skills-validator', 'bash', [path.join(root, 'scripts', 'validate-skills.sh')]));
checks.push(run('blackboard-test', process.execPath, [path.join(root, 'src', 'blackboard', 'test', 'blackboard-local.test.js')]));
checks.push(run('taskflow-test', process.execPath, [path.join(root, 'src', 'taskflow', 'test', 'taskflow-local.test.js')]));
checks.push(run('memory-adapters-test', process.execPath, [path.join(root, 'src', 'memory-adapters', 'test', 'memory-adapters-local.test.js')]));
checks.push(run('integration-adapters-test', process.execPath, [path.join(root, 'src', 'integration-adapters', 'test', 'mock-mcp-adapter.test.js')]));
checks.push(run('remote-approval-test', process.execPath, [path.join(root, 'src', 'remote-approval', 'test', 'remote-approval-local.test.js')]));
checks.push(run('skill-forge-test', process.execPath, [path.join(root, 'src', 'skill-forge', 'test', 'verify-skill-forge.js')]));
checks.push(run('demo-swarm', process.execPath, [path.join(root, 'examples', 'demo-swarm', 'run-demo.js')]));
checks.push(run('goal-loop-demo', process.execPath, [path.join(root, 'examples', 'goal-loop-demo', 'run-goal-demo.js')]));
checks.push(run('frontier-system-docs-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-frontier-system.js')]));
checks.push(run('frontier-orchestration-scale-eval', process.execPath, [path.join(root, 'scripts', 'eval-frontier-orchestration-scale.js')], { timeout: 120000 }));
checks.push(run('blackboard-contention-eval', process.execPath, [path.join(root, 'scripts', 'eval-blackboard-contention.js')], { timeout: 120000 }));
checks.push(run('self-healing-recovery-eval', process.execPath, [path.join(root, 'scripts', 'eval-self-healing-recovery.js')], { timeout: 120000 }));
checks.push(run('security-governance-eval', process.execPath, [path.join(root, 'scripts', 'eval-security-governance.js')], { timeout: 120000 }));
checks.push(run('memory-demo', process.execPath, [path.join(root, 'examples', 'memory-demo', 'run-memory-demo.js')]));
checks.push(run('remote-approval-demo', process.execPath, [path.join(root, 'examples', 'remote-approval-demo', 'run-remote-approval-demo.js')]));
removeGeneratedDemoOutputs();
checks.push(run('mission-control-board-json', process.execPath, ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(root, 'examples', 'mission-control-demo', 'board.json'))}, 'utf8')); console.log(JSON.stringify({ok:true}))`]));
checks.push(run('mission-control-writeback-json', process.execPath, ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(root, 'examples', 'mission-control-demo', 'writeback-intent.example.json'))}, 'utf8')); console.log(JSON.stringify({ok:true}))`]));
checks.push(run('graph-system-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-graph-system.js')]));
checks.push(run('communication-planes-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-communication-planes.js')]));
checks.push(run('wiki-index-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-wiki-index.js')]));
checks.push(run('delegation-router-policy-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-delegation-router-policy.js')]));
checks.push(run('agent-roster-manifest-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-agent-roster-manifest.js')]));
checks.push(run('public-release-boundaries-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-public-release-boundaries.js')]));
checks.push(run('bus-connectivity-diagnostics-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-bus-connectivity-diagnostics.js')]));
checks.push(run('maintainer-handoff-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-maintainer-handoff.js')]));
checks.push(run('ci-workflow-template-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-ci-workflow-template.js')]));
checks.push(run('repository-init-checklist-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-repository-init-checklist.js')]));
checks.push(run('codeowners-template-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-codeowners-template.js')]));
checks.push(run('supply-chain-policy-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-supply-chain-policy.js')]));
checks.push(run('changelog-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-changelog.js')]));
checks.push(run('release-notes-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-release-notes.js')]));
checks.push(run('reviewer-decision-schema-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-reviewer-decision-schema.js')]));
checks.push(run('github-hygiene-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-github-hygiene.js')]));
checks.push(run('public-surface-harness-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-public-surface-harness.js')]));
checks.push(run('operator-materials-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-operator-materials.js')]));
checks.push(run('owner-upload-approval-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-owner-upload-approval.js')]));
if (process.env.OPENCLAW_FRONTIER_STANDALONE_EXPORT !== '1') {
  checks.push(run('git-history-private-scan', process.execPath, [path.join(root, 'scripts', 'verify-git-history-clean.js')], { timeout: 120000 }));
}
checks.push(run('release-manifest', process.execPath, [path.join(root, 'release-gate', 'scripts', 'create-clean-export.js')]));
checks.push(run('release-manifest-parity', process.execPath, [path.join(root, 'release-gate', 'scripts', 'check-export-parity.js')]));
if (process.env.OPENCLAW_FRONTIER_SKIP_FRESH_EXPORT !== '1') {
  checks.push(run('fresh-export-test', process.execPath, [path.join(root, 'release-gate', 'scripts', 'verify-fresh-export.js')], { timeout: 120000 }));
}
checks.push(scanPrivateContent());

// Remove generated demo outputs after verification so they do not become package state.
removeGeneratedDemoOutputs();

const report = {
  schema: 'openclaw-frontier.package-verifier.v1',
  verificationScope: 'package-integrity-not-upload-approval',
  generatedAt: new Date().toISOString(),
  packageRoot: 'this package root',
  externalEffects: false,
  checks,
};
report.ok = checks.every((check) => check.ok);

const reportPath = path.join(reportDir, 'latest-verification.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({
  ok: report.ok,
  verificationScope: report.verificationScope,
  checks: checks.map((c) => ({
    name: c.name,
    ok: c.ok,
    ms: c.ms,
    findings: c.findings ? c.findings.length : undefined,
    error: c.ok ? undefined : c.error,
    stdout: c.ok ? undefined : (c.stdout || '').slice(0, 4000),
    stderr: c.ok ? undefined : (c.stderr || '').slice(0, 4000),
  })),
  report: path.relative(process.cwd(), reportPath),
}, null, 2));

process.exit(report.ok ? 0 : 1);
