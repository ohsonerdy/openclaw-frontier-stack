# Integration adapters

Production-safe external integration examples for OpenClaw Frontier Stack.

The package ships a single production implementation: a MCP-compatible local test-style adapter that demonstrates controlled tool discovery and tool calls without real endpoints, credentials, network access, or private service names. No live integrations (Slack, Telegram, Notion, GitHub, etc.) are shipped or wired in this package; this surface exists so consumers can build their own adapters against a stable contract.

## Run test

```bash
node src/integration-adapters/test/mock-mcp-adapter.test.js
```

## Adapter contract

The reference adapter exports the following surface from `lib/mock-mcp-adapter.js`:

- `SCHEMA` — schema id string `openclaw-frontier.integration-adapter.v1`.
- `MockMcpAdapter` — class with `registerTool(name, handler)`, `listTools()`, `callTool(name, input)`, and `getToolTrajectory()`.
- `ToolTrajectoryLog` — production-safe MCP/tool-call trajectory recorder.
- `scoreToolTrajectory(records)` — deterministic reliability scorer for recorded tool-call trajectories.
- `createDemoAdapter()` — factory wiring two local acceptance scenario tools.
- `IntegrationAdapterError` — thrown for validation, unknown-tool, and production-safety violations. Carries `code = 'INTEGRATION_ADAPTER_VALIDATION'` and a `details` object.

Tool names must match `/^[a-z][a-z0-9_.-]*$/` (lowercase, simple). Input is shallow-frozen before being passed to handlers.

Successful `callTool` returns an envelope:

```json
{ "schema": "openclaw-frontier.integration-adapter.v1", "toolName": "knowledge.search", "ok": true, "result": { } }
```

Failures throw `IntegrationAdapterError` rather than returning an `ok:false` envelope. Downstream callers that need result-style errors should wrap `callTool` and translate.

`listTools()` returns `{ schema, tools: string[] }` with tool names sorted.

## MCP/tool trajectory logging

Every `MockMcpAdapter` instance owns a `ToolTrajectoryLog` unless a caller passes one via `new MockMcpAdapter({ trajectoryLog })`. The log is designed for public reference packages and demo evidence, not raw debugging dumps. It records:

- deterministic sequence number;
- tool name;
- result status (`ok` or `error`);
- latency in milliseconds;
- input and result *shapes* plus SHA-256 digests, not raw payload text;
- operator-safe artifact references returned from `result.artifacts`;
- a reliability score derived from success rate, latency health, artifact coverage, and sequence integrity.

Example:

```js
const adapter = createDemoAdapter();
await adapter.callTool('knowledge.search', { query: 'blackboard claims' });
await adapter.callTool('artifact.summarize', { title: 'Demo', body: 'Synthetic body.' });
console.log(adapter.getToolTrajectory());
```

The trajectory shape is intentionally small and secret-free:

```json
{
  "schema": "openclaw-frontier.mcp-tool-trajectory.v1",
  "traceId": "demo-mcp-trace-001",
  "records": [
    {
      "sequence": 1,
      "toolName": "knowledge.search",
      "status": "ok",
      "latencyMs": 1,
      "inputShape": { "type": "object", "keys": ["query"] },
      "inputSha256": "...",
      "resultShape": { "type": "object", "keys": ["artifacts", "hits"] },
      "resultSha256": "...",
      "artifacts": [{ "id": "synthetic-knowledge-index", "type": "demo-corpus", "path": "examples/synthetic/knowledge-index.json" }]
    }
  ],
  "reliability": { "score": 1, "label": "high" },
  "publicSafe": true
}
```

The logger reuses the production-safety scanner, so artifact references and trajectory metadata cannot contain home paths, URLs, IP literals, or common token formats.

## Production-safety scanner

Before a tool runs, and again before the result is returned, the adapter scans the serialized payload for patterns that must never cross the public boundary:

- user home paths (POSIX `Users` and Windows `Users` directory prefixes)
- PEM private-key headers
- common API tokens (`sk-`, `ghp_`, `github_pat_`, `xox[abpors]-`)
- Telegram bot tokens (`12345678:AAA...`)
- IPv4 literals
- `http(s)://` URLs

Hitting any pattern raises `IntegrationAdapterError` with `details.pattern`. This is a production-safety net for the *reference* surface, not a substitute for a real adapter's own input validation and outbound allowlist.

## Building a real adapter

Production adapters built against this contract should preserve the same boundaries:

- validate tool names and input;
- keep secrets out of package artifacts and source — read credentials from environment variables only (e.g. `process.env.SLACK_BOT_TOKEN`), never hardcode tokens, webhook URLs, channel ids, or workspace ids;
- return bounded JSON results;
- attach verifier/readback evidence before results count as done;
- never expose live endpoints, tokens, private hostnames, or raw internal logs in public packages or test fixtures.

A minimal real-adapter skeleton looks like:

```js
const { MockMcpAdapter, IntegrationAdapterError } = require('@openclaw-frontier/integration-adapters');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new IntegrationAdapterError(`missing env ${name}`, { name });
  return v;
}

function createSlackAdapter() {
  const token = requireEnv('SLACK_BOT_TOKEN');
  return new MockMcpAdapter({ tools: {
    'slack.post_message': async ({ channel, text }) => {
      // call provider SDK with `token`, `channel`, `text`; return bounded JSON
      return { posted: true };
    },
  } });
}
```

The skeleton above is illustrative only; no Slack or other provider code ships with this package.
