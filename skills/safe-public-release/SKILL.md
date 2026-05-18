---
name: safe-public-release
description: Use before pushing a branch to a public remote. Runs the private-content scanner over the working tree and full git history, verifies the owner upload approval is bound to the exact candidate hash, and blocks the push if any gate fails. Triggers when the user mentions "push to main", "publish", "release", "ship to GitHub", "tag a release", "open-source this", or is about to force-push to a public remote. For full-history audits without a release in flight, use verified-history-scan. For coordinating multi-step work, use durable-task-ledger.
when_to_use: User asks to "push to main", "publish", "release", "ship to GitHub", "tag a release", or any branch is about to be force-pushed to a public remote.
metadata:
  version: 0.1.0
---

# Safe public release

You are about to perform an action whose blast radius is "public internet."
Before doing anything, run the gates. Do not paraphrase; run the scripts.

The two gates enforce two different invariants:

1. **History scan** — every commit reachable from any ref has been scanned
   for private content patterns. A clean working tree does not imply
   clean history; rebased commits, abandoned branches, and pre-scrub
   blobs may still be reachable on the remote.
2. **Owner upload approval** — if the operator pre-signed an approval for
   a specific candidate hash, the candidate currently being pushed must
   match that hash on all five tokens (manifest sha, tree sha, repo,
   branch, remote base sha). Approval is hash-bound by design so the
   operator can review out-of-band and not be tricked by a moving target.

## Procedure

### Step 1 — History scan

Run from the repo root:

```
node <plugin-dir>/scripts/verify-git-history-clean.js
```

The plugin is installed under your agent host's plugins directory
(Claude Code, Codex, Cursor, OpenCode — each puts plugins in a
different place; check your host's docs). The script walks
`git rev-list --all`, runs the 18-pattern scanner over every commit's
tree, and exits non-zero if any finding lands.

Output is JSON with:

- `schema` — version tag
- `ok` — boolean
- `commits` — total commits scanned
- `findings` — array of `{ commit, pattern, file, line }`

If exit non-zero, STOP. Show the findings to the user; do not propose a
fix without their approval. History contains rebased commits — clean
working tree does not imply clean history.

### Step 2 — Owner upload approval (conditional)

If `release-gate/owner-upload-approval.json` exists in the repo, run:

```
node <plugin-dir>/scripts/verify-owner-upload-approval.js
```

The approval must bind the exact current candidate hash with all five
tokens present in the approval phrase:

- `repo`
- `branch`
- `candidateManifestSha256`
- `candidateTreeSha256`
- `remoteBaseSha`

If any token missing or any SHA mismatched, STOP. The approval is for a
different candidate.

If the approval file is not present, the script exits 0 with
`approvalPresent: false`. Some workflows don't require an approval; if
the operator has set one up, the gate enforces it.

### Step 3 — Perform the push

Only after both gates exit zero, perform the user's requested action.
Note any deviations in the post-push report.

## What you must NEVER do

- **Suppress findings to make the gate pass.** The findings exist for a
  reason. If a pattern fires, the fix is in the tree, not in the gate.
- **Modify `lib/private-patterns.js` to remove a pattern that fires.**
  The pattern is shared across hooks, scripts, and tests. Narrowing it
  to silence one finding weakens every callsite.
- **Approve your own release.** The candidate-hash binding exists so the
  human operator signs off out-of-band. You are not the operator.
- **Use `--no-verify` to bypass a local pre-push hook.** The hook IS the
  gate. The hook running is the gate succeeding; the hook not running
  is the gate not running.
- **Carry an approval forward across tree changes.** Approval is
  hash-bound by design. If the tree changed even one byte, the manifest
  sha changes and the approval no longer applies.
- **Edit the allow-path regex in `verify-git-history-clean.js` to skip
  a file.** That's a back door. The right tool is
  `private-patterns-allow.local.json`, which is per-finding and
  reviewable.

## When the gate blocks legitimately

Show the user the failing finding(s). For each:

- **If it's a real leak**, identify the specific file:line and propose a
  fix. For leaks in the current HEAD, the fix is an edit. For leaks in
  history, the fix is more involved — usually `git filter-repo` after
  notifying any other clones. Do not propose `git filter-repo` casually;
  it rewrites history.
- **If it's a false positive** (e.g. an intentional test fixture,
  generated example, or documentation snippet that uses a fake token
  shape), add the file path to `private-patterns-allow.local.json` with
  a one-line comment explaining why. Do NOT narrow the regex.

Example allow-list entry:

```json
{
  "version": 1,
  "allowed_paths": [
    {
      "path": "examples/sample-output.md",
      "reason": "Demo output containing fake AKIA placeholder; not a real key.",
      "added_by": "adam",
      "added_at": "2026-05-18"
    }
  ]
}
```

## Reporting

After the gates pass and the action completes, summarize:

- Candidate hash (manifest sha or commit sha at HEAD)
- Whether owner approval was present and bound
- Tag (if any) and its SHA
- Anything added to the allow-list this turn, with the reason
- Total commits scanned and findings (should be 0)

## Related skills

- `verified-history-scan` — when the user wants the audit without a
  release in flight (e.g. before announcing a repo, after a force-push).
- `durable-task-ledger` — when coordinating multi-step work across
  subagents that may include the release step.
