#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { scan } = require('../lib/private-patterns');
const text = [
  ['user', '@', 'example', '.', 'com'].join(''),
  ['D:', '/', 'mission-control', '/', '.data', '/', '.auto-generated'].join(''),
  ['~', '/', '.openclaw', '/', '.vault', '/', 'key.priv'].join(''),
  ['github_pat_', '1234567890', '1234567890', '1234567890'].join(''),
].join('\n');
const ids = new Set(scan('fixtures/leak.txt', text).map((f) => f.pattern));
for (const id of ['email-address', 'drive-letter-path', 'tilde-home-path', 'github-token']) assert(ids.has(id), `missing ${id}`);
console.log('sentinel gate fixtures PASS');
