# Signed bus reference implementation

This is the sanitized NATS/JetStream signed-envelope bus from the OpenClaw Frontier Stack.

It provides:

- typed envelopes: `TASK`, `RESULT`, `FACT`, `OBSERVATION`, `DECISION`, `ALERT`, `HEARTBEAT`. The enum is closed; see `docs/bus-and-blackboard-protocol.md`;
- Ed25519 detached signatures over canonical JSON;
- public-key verification before handler execution;
- NATS JetStream transport using `squad.<TYPE>.<to>` subject routing;
- append-only audit log hooks;
- a local envelope test and an optional NATS roundtrip test.

## Safety boundary

The package includes code, schema, and tests only. It does not include live keys, live audit logs, live hostnames, private runtime state, or production NATS config.

Use `.env.example` with fake local values for demos.

## Local envelope test

```bash
cd src/signed-bus
npm install
npm run test:envelope
```

## Optional NATS roundtrip

Requires a local NATS server and generated demo keys:

```bash
SQUAD_BUS_AGENT_ID=orchestrator \
SQUAD_BUS_URL=nats://localhost:4222 \
SQUAD_BUS_PRIV_KEY=./keys/demo-orchestrator.pem \
SQUAD_BUS_KEYS_DIR=./keys \
npm run test:roundtrip
```

Do not use production keys in the public demo.
