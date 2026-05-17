#!/usr/bin/env node
'use strict';
const fs=require('fs'); const cp=require('child_process'); const crypto=require('crypto'); const path=require('path');
function sh(cmd){return cp.execSync(cmd,{encoding:'utf8'}).trim()}
const root=process.cwd();
const manifestPath=path.join(root,'release-gate','exports','clean-export-manifest.json');
const reportPath=path.join(root,'release-gate','reports','latest-verification.json');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
const manifestSha256=crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
const failed=(report.checks||[]).filter(c=>!c.ok);
const dirtyLines=sh('git status --short').split(/\r?\n/).filter(Boolean);
const pkt={
  schema:'openclaw.githubShipPacket.v1',
  generatedAt:new Date().toISOString(),
  owner:'public-release-operator',
  approval:'production release approved by owner for the exact candidate after verification gates',
  repo:'owner/openclaw-frontier-stack',
  branch:'main',
  sourceHead:sh('git rev-parse HEAD'),
  sourceTree:sh('git show -s --format=%T HEAD'),
  dirtyCount:dirtyLines.length,
  cleanExport:{path:manifest.exportPath,fileCount:manifest.fileCount,totalBytes:manifest.totalBytes,generatedAt:manifest.generatedAt,manifestSha256},
  verifier:{path:'release-gate/reports/latest-verification.json',ok:failed.length===0,checks:(report.checks||[]).length,failed:failed.map(c=>c.name),privateContentFindings:((report.checks||[]).find(c=>c.name==='private-content-scan')||{}).findings},
  preflight:{path:'scripts/release-preflight.js',configurablePrivateDenylist:'PRIVATE_DENYLIST_CSV'},
  forbiddenActions:'No credential mutation, service restart, purge/delete, force push, or public publish performed by packet generation.',
  next:'Run release preflight on exact clean export, stage exact export in temp repo, verify git identity, push only if public readback matches.'
};
fs.mkdirSync(path.join(root,'release-gate','evidence'),{recursive:true});
fs.writeFileSync(path.join(root,'release-gate','evidence','github-ship-packet.current.json'),JSON.stringify(pkt,null,2)+'\n');
console.log(JSON.stringify({wrote:'release-gate/evidence/github-ship-packet.current.json', ok:pkt.verifier.ok, checks:pkt.verifier.checks, manifestSha256, dirtyCount:pkt.dirtyCount},null,2));

