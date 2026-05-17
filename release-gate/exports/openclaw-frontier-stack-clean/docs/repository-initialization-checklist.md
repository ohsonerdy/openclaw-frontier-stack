# Repository initialization checklist

Status: SHIP as a production-safe checklist. This is not an instruction to publish.

Use this checklist only after the clean export has passed verification and the repository owner is ready to initialize a public repository. Do not copy live private repository configuration.

## Before creating a repository

- [ ] `node scripts/verify-package.js` passes.
- [ ] `node scripts/verify-package.js` has been rerun.
- [ ] `readyForGithubUpload` is `true` in `release-gate/reports/latest-release-status.json`.
- [ ] Architecture, Security, Operations, and Release reviewer decisions are present and non-blocking.
- [ ] A real root `LICENSE` exists and `README.md` names the selected license.
- [ ] The owner has explicitly approved upload/publication.

## Repository setup

- [ ] Initialize from `release-gate/exports/openclaw-frontier-stack-clean`, not from a live workspace.
- [ ] Add repository description from `README.md`; do not include private project names or host details.
- [ ] Copy GitHub templates from `templates/github/` after replacing placeholders.
- [ ] Convert `templates/github/CODEOWNERS.template` to `.github/CODEOWNERS` only after real maintainer handles are chosen.
- [ ] Keep Actions disabled or placeholder-only until maintainers intentionally add CI.
- [ ] Configure branch protection before inviting contributors.

## First public verification

After repository initialization, rerun package verification from the fresh repository clone. Treat any difference from the clean export manifest as a release blocker.
