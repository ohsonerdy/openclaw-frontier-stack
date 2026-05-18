#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const artifactsDir = path.join(root, 'release-gate', 'artifacts');
const cleanExportRoot = path.join(root, 'release-gate', 'exports', 'openclaw-frontier-stack-clean');
fs.mkdirSync(artifactsDir, { recursive: true });

execFileSync(process.execPath, [path.join(root, 'release-gate', 'scripts', 'create-clean-export.js')], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'pipe'],
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024,
});

const packArgs = ['pack', '--json', '--pack-destination', artifactsDir];
const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = npmCli && fs.existsSync(npmCli)
  ? execFileSync(process.execPath, [npmCli, ...packArgs], {
      cwd: cleanExportRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    })
  : execFileSync(npmCommand, packArgs, {
      cwd: cleanExportRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });

const packed = JSON.parse(output)[0];
const artifactPath = path.join(artifactsDir, packed.filename);
const result = {
  ok: fs.existsSync(artifactPath),
  source: 'release-gate/exports/openclaw-frontier-stack-clean',
  artifact: path.relative(root, artifactPath).replace(/\\/g, '/'),
  size: packed.size,
  integrity: packed.integrity,
  unpackedSize: packed.unpackedSize,
  fileCount: packed.entryCount,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
