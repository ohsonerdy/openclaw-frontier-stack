# Package edit claim convention

Status: ACTIVE
Owners: Architecture, Security, Operations, Release
Purpose: prevent silent overwrite races on `./` while multiple agents edit from separate checkouts.

## Rules

1. Before editing any file under `./`, sync the shared checkout to the latest commit on the working branch.
2. Append a claim line to `status/package-claims.log` in the same commit that lands the edit. Format:
   `YYYY-MM-DDThh:mm:ssZ\tagent\tpath\tcommit-subject`
3. One claim line per logical edit, not per file. A single coordinated change touching three files under one subdirectory counts as one claim.
4. If two agents need to edit the same subdirectory in the same loop, the second agent waits for the first agent's commit to land in the shared checkout, then re-syncs, then claims.
5. Verifier and exporter scripts in `release-gate/scripts/` are exempt from the claim rule when run read-only; any change to those scripts themselves is not exempt.
6. Conflicts are resolved by re-running `node ./scripts/verify-package.js` after merge; verifier `ok=true` is required before the next commit.

## Scope

- Applies to `./**` only.
- Status, eval-loop, and mission-control export paths follow their existing sync conventions and are not gated by this log.

## Failure mode

If a commit lands without a matching claim line, the next loop owner appends a retroactive claim line referencing the missing commit hash, and notes the gap in that loop's eval record. Repeated misses (3+ in 24h) escalate to a checklist P0 item.
