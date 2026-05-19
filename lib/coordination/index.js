'use strict';

/**
 * lib/coordination — coordination patterns for multi-agent orchestration.
 *
 * Five standalone patterns that sit ABOVE the blackboard + taskflow
 * primitives. Each emits task-claim records and reads back result records.
 * None of them manages the underlying FSM directly — they're composition
 * helpers.
 *
 * Pure JS, no runtime deps beyond the blackboard ledger and taskflow runtime.
 *
 * Patterns:
 *   - fanOut:          dispatch N independent tasks in parallel; wait for all
 *   - fanIn:           wait for N upstream tasks; dispatch a joiner over them
 *   - chain:           sequential N-step pipeline; each step sees prior output
 *   - voting:          cross-role decision; collect votes; apply quorum
 *   - subagentFanOut:  parent delegates N short-lived children with scoped
 *                      writes (children's intermediate facts stay in their
 *                      scope; only result records propagate to the parent)
 */

const { fanOut } = require('./fan-out.js');
const { fanIn } = require('./fan-in.js');
const { chain } = require('./chain.js');
const { voting } = require('./voting.js');
const { subagentFanOut, createScopedLedger, SubagentScopeError } = require('./subagent.js');

const PATTERNS = Object.freeze({
  'fan-out': fanOut,
  'fan-in': fanIn,
  chain,
  voting,
  subagent: subagentFanOut,
});

module.exports = {
  fanOut,
  fanIn,
  chain,
  voting,
  subagentFanOut,
  subagent: subagentFanOut,
  createScopedLedger,
  SubagentScopeError,
  PATTERNS,
};
