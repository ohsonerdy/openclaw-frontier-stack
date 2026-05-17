# Production Release Gate Hardening

This package now treats public release as a production release path. A release gate is valid only when it blocks unsafe states by command, CI, or exact owner approval binding.

## Required local gates

Run:

```bash
node scripts/verify-package.js
node scripts/verify-git-history-clean.js
node release-gate/scripts/verify-operator-materials.js
node release-gate/scripts/verify-owner-upload-approval.js
```

`verify-owner-upload-approval.js` passes without an approval file only to keep local verification usable. It reports `readyForExternalUpload:false`; that means push/sign/deploy is blocked.

## Owner counter-signature file

For any future external upload/sign/deploy, create `release-gate/owner-upload-approval.json` only after Adam approves the exact action in the same session. The file must bind:

- `approvedBy`
- `approvedAt`
- `repo`
- `branch`
- `candidateManifestSha256`
- `candidateTreeSha256`
- `remoteBaseSha`
- `approvalPhrase`

The approval phrase must include the repo, branch, candidate manifest SHA, and remote base SHA.

## Operator/public separation

Operator scripts, live probes, local infrastructure paths, vault paths, and private reviewer scratchpads do not belong in this public package tree. `verify-operator-materials.js` fails the package if known operator materials reappear.

## Fresh clone rule

After any public mutation, verify from a new clone. The receipt must include:

- final remote SHA
- current-tree private scan result
- all-history private scan result
- package verifier result
- JS syntax check result

No receipt, no DONE.