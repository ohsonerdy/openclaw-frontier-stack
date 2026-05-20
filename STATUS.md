# OpenClaw Frontier Stack Status

Status: published production source package.

This repository is the canonical public source for the OpenClaw Frontier Stack. New tagged releases, package-registry publishes, hosted deployments, external announcements, or customer-specific deployments require fresh target-bound approval and readback.

## Current gates

- Local package verifier: `npm run verify`
- Public-surface harness: `npm run verify:public-surface`
- GitHub API readback: `npm run verify:github-readback`
- Private content scan: included in `npm run verify`
- Git history scan: `npm run verify:history`

## Public-surface rule

The public tree must look like a product source repository, not an incident archive. Internal receipts, reviewer chatter, stale packets, generated reports, scratch exports, and private operational evidence belong outside the public tree.

Public release approval requires both API readback and browser readback because GitHub's sidebar contributor cache can diverge from the commit/contributors APIs.
