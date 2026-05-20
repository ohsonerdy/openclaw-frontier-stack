# Maintainer handoff

Status: SHIP as production-safe maintainer onboarding guidance. This is not publication approval.

Use this document when a maintainer reviews or receives the clean OpenClaw Frontier Stack package. It describes what to inspect, what not to import, and how to preserve the release boundary.

## What maintainers receive

- A release manifest generated from `release-gate/scripts/create-release-manifest.js`.
- Package docs, examples, templates, production implementations, and release-gate scripts.
- Local fixture data only.
- Reviewer, license, evidence, release-note, repository, CI, and supply-chain gate artifacts.

## What maintainers must not import

- Credentials, OAuth state, API keys, private keys, deployment keys, or registry tokens.
- Private hostnames, IP addresses, local filesystem paths, chat IDs, raw logs, memories, transcripts, vector stores, backups, or session databases.
- Client context, private business context, trading systems, personal lore, or personal cron jobs.
- Live Mission Control data, live blackboard state, or unreviewed runtime exports.

## Handoff checks

1. Work only from a freshly generated release artifact or source checkout that passes `npm run verify`.
2. Run `node scripts/verify-package.js` in the release manifest.
3. Run `node scripts/verify-package.js`.
4. Confirm `readyForGithubUpload` remains false unless all reviewer, license, and owner approval gates have been intentionally completed.
5. If any artifact differs from the release manifest manifest, stop and regenerate the export from the package source.

## Maintainer decision boundary

Maintainers may review, test, and propose changes. They may not publish, upload, create releases, enable CI, or invite contributors until the repository owner has explicitly approved those external actions.
