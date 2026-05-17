'use strict';

/**
 * roundtrip.js. Local self-test for squad-bus.
 *
 * Publishes one OBSERVATION envelope addressed to self, subscribes to the
 * matching subject, receives, verifies signature, exits.
 *
 * OBSERVATION type is non-human-facing in this demo. Safe to run locally.
 *
 * Required env:
 *   SQUAD_BUS_AGENT_ID  (e.g. neo)
 *   SQUAD_BUS_URL       (default nats://localhost:4222)
 *   SQUAD_BUS_PRIV_KEY  (default ./keys/<agent>.pem)
 *   SQUAD_BUS_KEYS_DIR  (default ./keys)
 *
 * Run:
 *   node test/roundtrip.js
 *
 * Expect: "PASS" + exit 0 within 10 seconds.
 */

const client = require('../lib/signed-bus-client');

const TIMEOUT_MS = 10000;

async function main() {
  const agentId = client._AGENT_ID;
  if (!agentId) {
    console.error('FAIL: SQUAD_BUS_AGENT_ID env var is required');
    process.exit(1);
  }
  console.log(`[roundtrip] agent=${agentId} bus=${client._BUS_URL}`);
  console.log(`[roundtrip] priv=${client._PRIV_KEY_PATH}`);
  console.log(`[roundtrip] keys=${client._KEYS_DIR}`);

  let unsubscribe;
  let passed = false;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout: no message received within 10s')), TIMEOUT_MS);

    client.subscribe(`OBSERVATION.${agentId}`, async (envelope) => {
      clearTimeout(timer);
      console.log('[roundtrip] received envelope id=' + envelope.id);
      if (envelope.from !== agentId) return reject(new Error(`wrong from: ${envelope.from}`));
      if (envelope.to !== agentId) return reject(new Error(`wrong to: ${envelope.to}`));
      if (envelope.type !== 'OBSERVATION') return reject(new Error(`wrong type: ${envelope.type}`));
      if (!envelope.signature) return reject(new Error('missing signature'));
      console.log('[roundtrip] signature verified by subscribe path');
      passed = true;
      resolve();
    }).then((fn) => { unsubscribe = fn; });
  });

  // Brief delay so subscribe has registered before publish
  await new Promise((r) => setTimeout(r, 500));

  const env = client.createSignedEnvelope({
    to: agentId,
    type: 'OBSERVATION',
    subject: 'roundtrip-test',
    body: { test: true, ts: Date.now() },
  });
  console.log('[roundtrip] publishing envelope id=' + env.id);
  await client.publish(env);

  await done;
  if (unsubscribe) unsubscribe();
  await client.close();

  console.log(passed ? '\nPASS' : '\nFAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: ' + err.message);
  process.exit(1);
});
