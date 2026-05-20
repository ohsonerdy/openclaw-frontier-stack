#!/usr/bin/env node
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=path.resolve(process.argv[2]||process.cwd());
const denylist=(process.env.PRIVATE_DENYLIST_CSV||'').split(',').map(s=>s.trim()).filter(Boolean);
const genericPatterns=[
{name:'private-key',re:/-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i},
{name:'github-token',re:/gh[pousr]_[A-Za-z0-9_]{20,}/},
{name:'slack-token',re:/xox[baprs]-[A-Za-z0-9-]{20,}/},
{name:'aws-access-key',re:/AKIA[0-9A-Z]{16}/},
{name:'openai-key',re:/sk-[A-Za-z0-9_-]{20,}/},
{name:'anthropic-key',re:/sk-ant-[A-Za-z0-9_-]{20,}/},
{name:'tailnet-hostname',re:/[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net/i},
{name:'lan-ip',re:/\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/},
{name:'absolute-user-path',re:/(?:\/Users\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+)/i},
{name:'telegram-chat-id',re:/telegram:-?\d{6,}/i},
{name:'long-numeric-chat-id',re:/\b-?100\d{8,}\b/}
];
const skipDirs=new Set(['.git','node_modules','.next','dist','build','coverage']);
const textExt=new Set(['.md','.txt','.json','.js','.mjs','.cjs','.ts','.tsx','.yml','.yaml','.html','.css','.gitignore','.license','']);
const scannerLiteralRules=new Set(['openai-key','anthropic-key','private-key','github-token','aws-access-key','absolute-user-path','telegram-chat-id','lan-ip','tailnet-hostname','long-numeric-chat-id']);
const scannerLiteralFiles=new Set(['scripts/release-preflight.js','release-gate/scripts/check-export-parity.js']);
const findings=[]; let files=0,bytes=0; const hash=crypto.createHash('sha256');
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){if(skipDirs.has(ent.name))continue; const p=path.join(dir,ent.name); const rel=path.relative(root,p).split(path.sep).join('/'); if(ent.isDirectory()){walk(p);continue} if(!ent.isFile())continue; files++; const buf=fs.readFileSync(p); bytes+=buf.length; hash.update(rel); hash.update('\0'); hash.update(buf); hash.update('\0'); const ext=path.extname(ent.name).toLowerCase(); if(!textExt.has(ext)&&buf.includes(0))continue; const txt=buf.toString('utf8'); for(const pat of genericPatterns){ if(pat.re.test(txt) && !(scannerLiteralFiles.has(rel) && scannerLiteralRules.has(pat.name))) findings.push({file:rel,rule:pat.name}); } for(const term of denylist){ if(term && txt.toLowerCase().includes(term.toLowerCase())) findings.push({file:rel,rule:'private-denylist'}); } }}
walk(root);
const result={ok:findings.length===0,root,files,bytes,treeContentSha256:hash.digest('hex'),findings};
console.log(JSON.stringify(result,null,2)); if(!result.ok)process.exit(2);
