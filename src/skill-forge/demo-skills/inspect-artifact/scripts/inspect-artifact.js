#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const target = process.argv[2];
if (!target) {
  console.error('usage: inspect-artifact.js <path>');
  process.exit(2);
}

const resolved = path.resolve(target);
const deny = [/\.env(?:\.|$)/i, /\.pem$/i, /\.key$/i, /session/i, /memory-dump/i, /token/i, /secret/i, /credential/i];
if (deny.some((re) => re.test(resolved))) {
  console.error(JSON.stringify({ ok: false, error: 'denied-path-pattern' }));
  process.exit(3);
}

const buf = fs.readFileSync(resolved);
const text = buf.toString('utf8');
const preview = text.replace(/[\r\n]+/g, '\n').slice(0, 500);

console.log(JSON.stringify({
  ok: true,
  path: target,
  bytes: buf.length,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  preview,
}, null, 2));
