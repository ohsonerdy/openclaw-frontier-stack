# OpenClaw Frontier Stack release checklist

Status: draft checklist for future release candidate. This is not an approval.

## Package evidence

- [ ] Package root is clean-room/sanitized, not live runtime dump.
- [ ] README explains OpenClaw Frontier Stack professionally.
- [ ] Architecture docs present:
  - [ ] release scope
  - [ ] bus and blackboard protocol
  - [ ] memory/RAG/CAG/compaction
  - [ ] TaskFlow/result contracts
  - [ ] end-to-end trace model
  - [ ] Mission Control control plane
  - [ ] Sentinel release gate
- [ ] Synthetic demos present:
  - [ ] demo-swarm
  - [ ] memory-demo
  - [ ] Mission Control demo board
- [ ] JSONL blackboard ledger test passes.
- [ ] Generated demo outputs are gitignored or regenerated during verification.

## Verification commands

Run from package root or workspace root:

```bash
node ./examples/demo-swarm/run-demo.js
node ./src/blackboard/test/blackboard-local.test.js
node ./examples/memory-demo/run-memory-demo.js
python3 -m json.tool ./examples/mission-control-demo/board.json >/tmp/board.pretty.json
python3 -m json.tool ./examples/mission-control-demo/writeback-intent.example.json >/tmp/intent.pretty.json
```

Expected minimum:

- demo-swarm: `ok: true`, 12 envelopes, 6 tasks, 1 path claim, `APPROVE_RELEASE_CANDIDATE`.
- blackboard ledger: `ok: true`, collision rejected, unsafe paths rejected, JSONL parsed.
- memory-demo: `ok: true`, synthetic retrieval hit(s), CAG hash, compaction summary, accepted promotions.
- Mission Control JSON validates.

## Exclusion scan

Block on any live/private hit:

- credentials, tokens, OAuth/cache state, SSH private keys, vault material;
- personal memories, transcripts, Telegram IDs, private chats;
- client/private business context;
- personal-domain content (financial, hobby, or relationship contexts);
- real hostnames, IPs, machine names, absolute private paths;
- raw logs, session DBs, vector stores, backups, personal cron jobs.

Allowed contextual mentions are only in exclusion/safety policy text, not as live values.

## Reviewer decisions

- [ ] Architecture: MISSING
- [ ] Security: MISSING
- [ ] Operations: MISSING
- [ ] Release: MISSING
- [ ] the operator upload authorization: MISSING

## Final rule

Do not push to GitHub or publish externally until every required role is APPROVE and the operator explicitly authorizes upload.
