# OpenClaw Frontier Stack Status

Status: published production release.

Current public package state is defined by this file. Other release records are historical unless they explicitly say they are current.

## Current gates

- Package verification: `npm test` / `npm run verify` checks package integrity only.
- Private-content gate: `release-gate/scripts/sentinel-gate.js` must pass before public release work.
- Upload/owner approval: separate from package verification; see `npm run verify:owner-approval` when an external upload approval packet is being prepared.

## Public-surface rule

This repository is product documentation and source, not an incident archive. Internal incident receipts, reviewer chatter, stale packets, generated reports, scratch exports, and private operational evidence belong outside the public tree.
