'use strict';

/**
 * lib/coordination — coordination patterns for multi-agent orchestration.
 *
 * Four standalone patterns that sit ABOVE the blackboard + taskflow primitives.
 * Each emits task-claim records and reads back result records. None of them
 * manages the underlying FSM directly — they're composition helpers.
 *
 * Pure JS, no runtime deps beyond the blackboard ledger and taskflow runtime.
 *
 * Patterns:
 *   - fanOut:  dispatch N independent tasks in parallel; wait for all to finish
 *   - fanIn:   wait for N upstream tasks; dispatch a joiner that consumes them
 *   - chain:   sequential N-step pipeline; each step sees the prior step's output
 *   - voting:  cross-role decision; collect votes; apply quorum + threshold
 */

const { fanOut } = require('./fan-out.js');
const { fanIn } = require('./fan-in.js');
const { chain } = require('./chain.js');
const { voting } = require('./voting.js');

const PATTERNS = Object.freeze({
  'fan-out': fanOut,
  'fan-in': fanIn,
  chain,
  voting,
});

module.exports = { fanOut, fanIn, chain, voting, PATTERNS };
