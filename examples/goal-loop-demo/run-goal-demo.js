#!/usr/bin/env node
'use strict';

// Synthetic local-only Frontier goal loop demo.
// No external services, no live credentials, no private runtime data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outDir = path.join(__dirname, 'out');
const receiptsDir = path.join(outDir, 'receipts');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(receiptsDir, { recursive: true });

const now = () => new Date().toISOString();
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

const goal = {
  id: 'GOAL-FRONTIER-SYSTEM-DEMO-001',
  status: 'active',
  owner: 'Orchestrator',
  source: 'synthetic /goal demo',
  title: 'Ship Frontier as an operating system, not just code',
  definitionOfDone: 'Goal card, receipts, verifier loop, synthesis loop, agent roles, and smoke path all verify locally.',
  cadence: { operatorUpdateMinutes: 30, channel: 'operator-chat' },
  lanes: [
    { name: 'implementation', owner: 'Builder', receipt: 'receipts/implementation.md' },
    { name: 'documentation', owner: 'Docs', receipt: 'receipts/documentation.md' },
    { name: 'verification', owner: 'Verifier', receipt: 'receipts/verification.md' },
    { name: 'release-packaging', owner: 'Release Manager', receipt: 'receipts/release-packaging.md' },
    { name: 'final-approval', owner: 'Orchestrator + Sentinel', receipt: 'receipts/final-approval.md' },
  ],
  green: [],
  red: ['Verification not run yet'],
};

function writeReceipt(lane, verdict, evidence, remainingRisk = 'None for local synthetic validation.') {
  const body = [
    `# ${lane.name} receipt`,
    '',
    `Owner role: ${lane.owner}`,
    `Started: ${now()}`,
    `Finished: ${now()}`,
    `Verdict: ${verdict}`,
    '',
    'Evidence:',
    ...evidence.map((item) => `- ${item}`),
    '',
    `Remaining risk: ${remainingRisk}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, lane.receipt), body);
}

fs.writeFileSync(path.join(outDir, 'goal-card.json'), JSON.stringify(goal, null, 2) + '\n');

writeReceipt(goal.lanes[0], 'GREEN', [
  'Synthetic goal card created.',
  'Lane receipt contract exercised.',
  'No external writes performed.',
]);
writeReceipt(goal.lanes[1], 'GREEN', [
  'docs/goal-system.md documents card, receipts, verifier, synthesis, cadence.',
  'docs/agent-system.md documents roles, setup, verifier behavior, smoke path.',
]);
writeReceipt(goal.lanes[2], 'GREEN', [
  'Verifier checks every lane receipt exists and includes a verdict.',
  'Verifier report emitted to examples/goal-loop-demo/out/verification-report.json.',
]);
writeReceipt(goal.lanes[3], 'GREEN', [
  'Release package includes local goal-loop smoke path.',
  'Goal-loop smoke path is included in scripts/verify-package.js.',
]);
writeReceipt(goal.lanes[4], 'RED', [
  'Local synthetic demo can approve production-ready behavior.',
  'External GitHub publish remains outside this demo and requires explicit approval.',
], 'Public upload approval must bind the final candidate after verification.');

function verifyGoal(goalPath) {
  const checks = [];
  function check(name, ok, detail) { checks.push({ name, ok, detail }); }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
    check('goal-card-parse', true, goalPath);
  } catch (error) {
    check('goal-card-parse', false, String(error.message || error));
    return { ok: false, checks };
  }

  check('owner-is-orchestrator', parsed.owner === 'Orchestrator', `owner=${parsed.owner}`);
  check('cadence-30-minutes', parsed.cadence && parsed.cadence.operatorUpdateMinutes === 30, JSON.stringify(parsed.cadence));
  check('lanes-present', Array.isArray(parsed.lanes) && parsed.lanes.length >= 5, `lanes=${parsed.lanes && parsed.lanes.length}`);

  for (const lane of parsed.lanes || []) {
    const receiptPath = path.join(outDir, lane.receipt || '');
    const exists = Boolean(lane.receipt) && fs.existsSync(receiptPath);
    check(`receipt-exists:${lane.name}`, exists, lane.receipt || '<missing>');
    if (!exists) continue;
    const text = fs.readFileSync(receiptPath, 'utf8');
    const verdictMatch = text.match(/^Verdict: (GREEN|RED|BLOCKED)$/m);
    check(`receipt-verdict:${lane.name}`, Boolean(verdictMatch), lane.receipt);
  }

  return { ok: checks.every((item) => item.ok), checks };
}

const report = verifyGoal(path.join(outDir, 'goal-card.json'));
report.generatedAt = now();
report.failClosed = true;
report.reportSha256 = sha(JSON.stringify(report.checks));
fs.writeFileSync(path.join(outDir, 'verification-report.json'), JSON.stringify(report, null, 2) + '\n');

goal.status = report.ok ? 'verify' : 'blocked';
goal.green = report.checks.filter((item) => item.ok).map((item) => item.name);
goal.red = report.checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`);
fs.writeFileSync(path.join(outDir, 'goal-card.verified.json'), JSON.stringify(goal, null, 2) + '\n');

const finalSynthesis = [
  '# Final synthesis',
  '',
  'What shipped:',
  '- Synthetic `/goal` card format.',
  '- Lane receipts for implementation, documentation, verification, release packaging, and final approval.',
  '- Fail-closed verifier report.',
  '- Final synthesis artifact.',
  '- 30-minute operator update cadence encoded on the goal card.',
  '',
  'What was verified:',
  ...report.checks.map((item) => `- ${item.ok ? 'GREEN' : 'RED'} ${item.name}: ${item.detail}`),
  '',
  'What remains red:',
  '- Public GitHub publication requires explicit approval bound to the final candidate.',
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'final-synthesis.md'), finalSynthesis);

console.log(JSON.stringify({
  ok: report.ok,
  goalCard: path.relative(process.cwd(), path.join(outDir, 'goal-card.verified.json')),
  verificationReport: path.relative(process.cwd(), path.join(outDir, 'verification-report.json')),
  synthesis: path.relative(process.cwd(), path.join(outDir, 'final-synthesis.md')),
  checks: report.checks.map((item) => ({ name: item.name, ok: item.ok })),
}, null, 2));

process.exit(report.ok ? 0 : 1);
