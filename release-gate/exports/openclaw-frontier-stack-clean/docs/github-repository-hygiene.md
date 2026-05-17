# GitHub repository hygiene

Status: SHIP as sanitized templates only.

This package can be prepared as a public repository only after the release gate passes and the human upload approval file is satisfied. Repository metadata must be generated from clean templates, not copied from a live private workspace.

## Required public repo files

- `README.md` — package overview, scope, exclusions, and current release status.
- `LICENSE` — selected by the operator before publication.
- `CONTRIBUTING.md` — contributor expectations, local verification, and privacy boundaries.
- `SECURITY.md` — vulnerability reporting and secret-handling policy.
- `CODE_OF_CONDUCT.md` — community behavior expectations.
- `.github/pull_request_template.md` — release-scope checklist for every PR.
- `.github/ISSUE_TEMPLATE/*.md` — issue intake with explicit no-secret guidance.

## Metadata rules

1. Do not copy private repository settings, teams, remotes, secrets, Actions variables, or deployment keys.
2. Use synthetic examples only; no real hostnames, IPs, chat IDs, customer names, local paths, logs, memory dumps, transcripts, vector stores, or backups.
3. Keep GitHub Actions disabled or placeholder-only until the clean export has passed scanners in the target repository.
4. Treat screenshots as release artifacts: scan them the same way as text for private paths, handles, and host details.
5. Require reviewer decision records and explicit human upload approval before any external publication.

## Suggested first public branch protection

- Require pull request review before merge.
- Require status checks for the package verifier and clean-export script.
- Block force pushes to the default branch.
- Require signed commits or signed tags when available.
- Restrict who can create releases until the package has a mature release process.

## Local verification before repository initialization

Run from the package root:

```sh
node scripts/verify-package.js
node scripts/verify-package.js
```

The package is not GitHub-ready if `readyForGithubUpload` is `false` in `release-gate/reports/latest-release-status.json`.
