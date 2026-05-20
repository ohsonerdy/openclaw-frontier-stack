# Supply-chain security policy

Status: SHIP as production-safe package policy.

OpenClaw Frontier Stack is a production architecture package, not a live runtime export. Dependencies, generated files, and release artifacts must remain reviewable and reproducible before any GitHub publication.

## Dependency rules

1. Prefer dependency-free production implementations for core examples.
2. If a dependency is required, document why it is necessary and keep it scoped to the package surface that needs it.
3. Do not commit `node_modules`, virtual environments, caches, lockfile artifacts generated outside the package, model weights, vector stores, logs, backups, or runtime databases.
4. Do not add GitHub Actions secrets, package registry tokens, deployment keys, OAuth files, or private endpoints to templates.
5. Keep optional networked services behind explicit local acceptance scenario instructions and fake configuration values.

## Generated artifact rules

- Acceptance scenario output directories must stay ignored and reproducible.
- Release manifest artifacts must be produced by `release-gate/scripts/create-release-manifest.js`.
- The release manifest manifest must match disk contents through `release-gate/scripts/check-export-parity.js`.
- Release status must be regenerated after verifier, export, reviewer, license, or approval gate changes.

## Review requirements

Supply-chain changes require reviewer attention when they:

- add a new dependency;
- add a package manager, lockfile, or install command;
- introduce a network call;
- alter release manifest scope;
- alter private-content scanning;
- add automation intended for GitHub, registry, or release publishing.

## Publication boundary

Passing supply-chain checks alone does not authorize publication. New tagged releases, package-registry publishes, hosted deployments, or external announcements remain blocked until reviewer records, license selection, and explicit owner approval are complete.
