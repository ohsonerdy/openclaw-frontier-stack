'use strict';

/**
 * surface-integrity — re-runs the public-surface harness as a child process
 * and converts its findings count to a score.
 *
 * Score = max(0, 100 - findings_count * 5).
 *
 * The harness emits JSON to stdout regardless of exit code. We parse it.
 */

const { execFileSync } = require('child_process');
const path = require('path');

async function score(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..', '..');
  const harnessPath = path.join(root, 'release-gate', 'scripts', 'verify-public-surface-harness.js');
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [harnessPath], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout = err.stdout ? String(err.stdout) : '';
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* fallthrough */ }
  if (!parsed || !Array.isArray(parsed.findings)) {
    return {
      score: 0,
      detail: {
        ok: false,
        exitCode,
        parseError: 'could not parse public-surface harness output as JSON',
        outputSnippet: stdout.slice(0, 400),
      },
    };
  }
  const findings = parsed.findings;
  const finalScore = Math.max(0, 100 - findings.length * 5);
  return {
    score: finalScore,
    detail: {
      ok: parsed.ok === true,
      exitCode,
      findingCount: findings.length,
      checkedCommits: parsed.checkedCommits || 0,
      sampleFindings: findings.slice(0, 5).map((f) => ({
        file: f.file || null,
        issue: f.issue || null,
        line: f.line || null,
      })),
    },
  };
}

module.exports = { score };
