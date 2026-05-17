# Release Gates and Privacy

The public release process includes automated private-content scanning, package verification, git-history scanning, and explicit owner-upload approval binding.

This public document intentionally avoids internal operator names, private incident receipts, hostnames, paths, or chat transcripts. Detailed incident response records remain in private operational ledgers.

## Required gates

1. `npm test` / `npm run verify` for package integrity.
2. `npm run verify:history` for reachable-history private-content checks.
3. `node release-gate/scripts/sentinel-gate.js` for shipped-file private-content, syntax, dependency, and stale-state checks.
4. `npm run verify:owner-approval` only when preparing an external upload approval.

Verification passing does not by itself authorize any external upload. Approval is a separate explicit gate.
