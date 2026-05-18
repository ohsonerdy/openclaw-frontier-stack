---
name: verified-history-scan
description: Run the private-content scanner against the FULL git history (every commit's tree), not just the current HEAD. Use before publishing a previously-private repo, after a force-push, or anytime you need to verify a scrub was complete. Triggers when the user asks to "audit this repo before going public", "scan git history", "verify the scrub worked", "make this repo public", or has just done a git filter-repo or force-push. For a release-time gate, use safe-public-release. For coordinating multi-step work, use durable-task-ledger.
when_to_use: User asks to "audit this repo before going public", "scan git history", "verify the scrub worked", or has just done a `git filter-repo` or force-push.
metadata:
  version: 0.1.0
---

# Verified history scan

A working tree can be clean while the git history still contains leaks.
Any commit reachable from any ref carries the trees of every file in
that commit. A force-push removes commits from refs but does NOT remove
blobs from the object database — those persist on the remote unless
GC runs (and GC on GitHub is not on a schedule the operator controls).

This skill exists to verify a repo is publishable on a per-commit basis,
not just a per-HEAD basis.

## When this is needed

- **Before going public.** The repo was private; now the operator wants
  to flip the visibility flag. The clean HEAD is necessary but not
  sufficient. Anything ever committed is still in the object database
  unless it was specifically rewritten with `git filter-repo` AND the
  rewrite was force-pushed AND any clones were re-fetched or deleted.
- **After a force-push.** A force-push hides commits from refs but the
  blobs persist. If the force-push was meant as a scrub, this scan
  verifies the scrub actually worked.
- **After `git filter-repo`.** The operator rewrote history to remove
  something. This scan verifies the rewrite caught everything.
- **Before a tag or release.** Tags are immutable; whatever ships ships
  forever. Better to catch a leak now than after npm download counters
  start ticking.
- **Audit-on-demand.** Someone asks "is this repo clean?" — the right
  answer is the output of this scan, not "I think so."

## Procedure

### Step 1 — Run the scan

From the repo root:

```
node <plugin-dir>/scripts/verify-git-history-clean.js
```

Plugin install path is typically under your agent host's plugins
directory (Claude Code, Codex, Cursor, OpenCode — each puts plugins
in a different place). The script walks `git rev-list --all` and
runs the 18-pattern scanner over every commit's tree. Output is JSON
to stdout.

The schema:

```json
{
  "schema": "openclaw-frontier.git-history-clean.v1",
  "ok": false,
  "commits": 247,
  "findings": [
    { "commit": "abc123def456", "pattern": "email-address", "file": "README.md", "line": 12, "match": "[redacted]" },
    ...
  ]
}
```

Exit code is the gate: 0 means `ok: true`, 1 means findings present.
The script caps at 50 findings per run; if you hit the cap, fix the
worst offenders and re-run.

### Step 2 — Classify each finding

For each finding, decide which bucket:

- **Real leak in a removed-but-reachable commit.** The leak is still
  fetchable from the remote. Document it in a remediation log; consider
  `git filter-repo` to scrub the blob; communicate the leak to any
  parties whose data was exposed. Notify before remediating — once you
  rewrite history, the evidence is harder to point at.
- **Real leak in a current-HEAD file.** Fix in the working tree, commit
  the fix, then re-run the scan. The fix-then-rescan loop is the
  standard remediation for current-tree leaks.
- **False positive (test fixture, generated example, documentation
  snippet).** Add the path to `private-patterns-allow.local.json` with
  a one-line justification. Format:

  ```json
  {
    "version": 1,
    "allowed_paths": [
      {
        "path": "docs/example-output.md",
        "reason": "Example output containing fake AKIA placeholder.",
        "added_by": "adam",
        "added_at": "2026-05-18"
      }
    ]
  }
  ```

  Note: the allow-list is read at scan time. Adding an entry only
  affects future runs of the scanner.

### Step 3 — Re-run until clean

The exit code is your gate. Re-run after each fix to confirm. A clean
run looks like:

```json
{
  "schema": "openclaw-frontier.git-history-clean.v1",
  "ok": true,
  "commits": 247,
  "findings": []
}
```

## What you must NEVER do

- **Trust a clean HEAD scan to mean "history is clean."** It doesn't.
  Clean HEAD says nothing about reachable commits or unreachable blobs
  on the remote.
- **Force-push as a remediation strategy without also running this
  scan afterward.** A real-world example: on 2026-05-17 a force-push
  on the frontier-stack repo scrubbed file contents but the audit
  caught the bot identity leaking the same email in commit metadata
  before a second push fixed it. Force-push is a tool, not a remedy.
- **Narrow the regex set to make findings go away.** The 18 patterns
  are tuned. If a pattern fires on a string that shouldn't trip it,
  the right fix is `private-patterns-allow.local.json`, not regex
  narrowing.
- **Skip this skill on "small" repos.** The 18 patterns are cheap to
  run. A 1,000-commit repo scans in seconds. The cost of missing a
  leak is the leak. There's no repo so small the math flips.
- **Treat the allow-list as a dumping ground.** Every entry needs a
  one-line reason. Future-you reviews the allow-list periodically; if
  the reasons are missing or hand-wavy, you can't tell legitimate
  allowlist entries from drift.

## Detection coverage

The scanner checks for, among other things:

- Email addresses (any RFC-shaped local-part `@` domain)
- POSIX, Windows, tilde, drive-letter, and `/home/` paths that betray
  the operator's local layout
- RFC1918 private IPv4 and the CGNAT range (RFC6598)
- Tailscale tailnet hostnames
- OpenSSH private key blocks
- API token shapes for Anthropic, OpenAI, GitHub (PAT and app), AWS
  access keys, Slack tokens, Google API keys
- Telegram bot tokens
- Long numeric IDs (Telegram chat IDs, etc.)
- Project-specific paths and category enumerations

Custom deny terms can be added at runtime via the
`OPENCLAW_FRONTIER_DENY_TERMS` env var (comma-separated, up to 50
entries). This is useful for project-specific code names or partner
identifiers that are public-unsafe but generic enough that hard-coding
into the pattern list would hurt other projects.

## Relationship to the Stop hook

The plugin's `private-content-scan.js` Stop hook scans only files
changed vs. HEAD in the current working tree. This skill scans the
FULL git history. They complement each other:

- Stop hook = catch-as-you-go for files in flight
- This skill = audit-on-demand for everything reachable

Run this skill at decision boundaries (publishing, releasing, scrubbing).
Let the hook run continuously.

## Related skills

- `safe-public-release` — runs this scan as one of two gates before a
  push to a public remote.
- `durable-task-ledger` — record the audit result as a fact for future
  reference: `ledger.recordFact({ agent: 'agent-1', subject:
  'history-audit', value: { date: '2026-05-18', ok: true, commits: 247
  } })`.
