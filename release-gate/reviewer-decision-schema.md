# Reviewer decision schema

Status: SHIP as release-gate schema documentation.

Reviewer decision records are YAML files stored under `release-gate/reviewer-decisions/`. They are human-authored release-gate evidence, not upload approval by themselves.

## Required top-level fields

- `reviewer` — one of `Architecture`, `Security`, `Operations`, or `Release`.
- `version` — clean export candidate version under review.
- `decision` — one of `APPROVE_RELEASE_CANDIDATE`, `APPROVE_RELEASE_CANDIDATE`, or `BLOCK`.
- `reviewed_at` — UTC timestamp for the decision.
- `evidence` — one or more package-relative evidence paths with notes.
- `conditions` — required follow-up conditions, or `none`.
- `blockers` — blockers, or `none`.
- `notes` — short human-readable summary.

## Decision meaning

- `APPROVE_RELEASE_CANDIDATE`: reviewer accepts the candidate for owner upload approval, subject to all other gates.
- `APPROVE_RELEASE_CANDIDATE`: reviewer accepts the candidate as a sanitized production/reference package only.
- `BLOCK`: reviewer found a release blocker that must be resolved and re-reviewed.

## Privacy constraints

Decision records must not include credentials, OAuth state, private hostnames/IPs, private filesystem paths, chat IDs, raw logs, memories/transcripts, vector stores, backups, client/private context, domain-specific private systems, or personal cron jobs.

## Gate boundary

All required reviewer decisions must be present and non-blocking before owner upload approval can even be requested. Reviewer approval never substitutes for license selection or explicit owner upload approval.
