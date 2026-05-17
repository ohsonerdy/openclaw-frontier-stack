# Fresh-clone verification

Status: SHIP as production-safe verification guidance.

Before any GitHub publication, reviewers should verify the clean export as if it were a fresh repository clone. This catches hidden dependencies on the private workspace and confirms the package can stand alone.

## Procedure

From the package root:

```sh
node scripts/verify-package.js
node release-gate/scripts/verify-fresh-export.js
node scripts/verify-package.js
```

The fresh-export verifier copies `release-gate/exports/openclaw-frontier-stack-clean` into a temporary directory and runs the package verifier there with recursion disabled. It must not need live credentials, private paths, network access, local runtime state, or external services.

## Expected current state

- Fresh export verification passes.
- `readyForGithubUpload` remains false until reviewer, license, and owner approval gates are completed.
- Any fresh-export failure is a release blocker.

## Boundary

Fresh-clone verification is evidence only. It does not publish, push to GitHub, create a repository, enable CI, announce externally, or approve upload.
