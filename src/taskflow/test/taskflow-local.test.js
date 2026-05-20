#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { TaskFlowRuntime, TaskFlowError, validateRelPath } = require('../lib/taskflow');

const tf = new TaskFlowRuntime({ now: (() => { let i = 0; return () => `2026-01-01T00:00:0${i++}.000Z`; })() });

tf.createTask({ taskId: 'task-001', title: 'Build synthetic package artifact', owner: 'neo', inputs: { scope: 'demo' } });
tf.claimTask({ taskId: 'task-001', agent: 'builder' });
tf.waitTask({ taskId: 'task-001', agent: 'builder', reason: 'waiting for reviewer readback', wakeAfter: 'readback' });
tf.claimTask({ taskId: 'task-001', agent: 'builder' });
tf.completeTask({ taskId: 'task-001', agent: 'builder', status: 'ok', summary: 'Artifact complete.', artifacts: ['out/demo.patch'] });

const snap = tf.snapshot();
assert.strictEqual(snap.tasks['task-001'].state, 'done');
assert.strictEqual(snap.tasks['task-001'].agent, 'builder');
assert.deepStrictEqual(snap.tasks['task-001'].artifacts, ['out/demo.patch']);
assert.strictEqual(snap.counts['task-created'], 1);
assert.strictEqual(snap.counts['task-result'], 1);

assert.throws(() => tf.claimTask({ taskId: 'missing', agent: 'builder' }), TaskFlowError);
assert.throws(() => tf.completeTask({ taskId: 'task-002', agent: 'builder', summary: 'bad', artifacts: ['/absolute'] }), TaskFlowError);
assert.throws(() => validateRelPath('notes/token-output.txt'), TaskFlowError);
assert.strictEqual(validateRelPath('docs/demo-output.md'), 'docs/demo-output.md');

console.log(JSON.stringify({ ok: true, tasks: Object.keys(snap.tasks).length, events: snap.events.length, state: snap.tasks['task-001'].state }, null, 2));
