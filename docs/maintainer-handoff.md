# Maintainer handoff

Status: SHIP as production-safe maintainer onboarding guidance. This is not publication approval.

Use this document when a maintainer reviews or receives the clean OpenClaw Frontier Stack package. It describes what to inspect, what not to import, and how to preserve the release boundary.

## What maintainers receive

- A clean export generated from `release-gate/scripts/create-clean-export.js`.
- Package docs, examples, templates, reference implementations, and release-gate scripts.
- Synthetic demo data only.
- Reviewer, license, evidence, release-note, repository, CI, and supply-chain gate artifacts.

## What maintainers must not import

- Credentials, OAuth state, API keys, private keys, deployment keys, or registry tokens.
- Private hostnames, IP addresses, local filesystem paths, chat IDs, raw logs, memories, transcripts, vector stores, backups, or session databases.
- Client context, private business context, trading systems, personal lore, or personal cron jobs.
- Live Mission Control data, live blackboard state, or unreviewed runtime exports.

## Handoff checks

1. Work only from `release-gate/exports/openclaw-frontier-stack-clean`.
2. Run `node scripts/verify-package.js` in the clean export.
3. Run `node scripts/verify-package.js`.
4. Confirm `readyForGithubUpload` remains false unless all reviewer, license, and owner approval gates have been intentionally completed.
5. If any artifact differs from the clean export manifest, stop and regenerate the export from the package source.

## Maintainer decision boundary

Maintainers may review, test, and propose changes. They may not publish, upload, create releases, enable CI, or invite contributors until the repository owner has explicitly approved those external actions.
