# Blackboard ledger

Production-safe JSONL blackboard implementation for OpenClaw Frontier Stack demos and adapters.

The blackboard records durable coordination facts that should not live only in chat:

- task claims;
- path claims and releases;
- facts with evidence pointers;
- decisions;
- results with artifact paths.

## Safety model

This package intentionally uses a small local ledger with no network access and no external dependencies. It validates public-package safety before appending records:

- paths must be relative;
- absolute paths, URLs, `..`, empty segments, and home-directory paths are rejected;
- secret-like path segments such as `.env`, `token`, `secret`, `credential`, `private`, `oauth`, `session`, and key-file extensions are rejected;
- record JSON is scanned for common private path, private key, API token, bot-token, and IP-address shapes.

## Example

```js
const { BlackboardLedger } = require('./lib/ledger');

const board = new BlackboardLedger({ ledgerPath: './blackboard.jsonl' });
board.claimTask({ agent: 'builder', taskId: 'task-001', summary: 'Build demo artifact.' });
board.claimPath({ agent: 'builder', taskId: 'task-001', path: 'src/demo.js' });
board.recordResult({
  agent: 'builder',
  taskId: 'task-001',
  ok: true,
  summary: 'Demo artifact complete.',
  artifacts: ['out/demo.patch'],
});
```

Run local test:

```bash
node src/blackboard/test/blackboard-local.test.js
```
