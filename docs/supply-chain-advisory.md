# Supply-chain advisory check

`npm run verify:supply-chain` runs the supply-chain advisory checker. It is
a fail-closed gate: any HIGH or CRITICAL advisory that is not covered by an
unexpired allowlist entry makes the check exit non-zero.

## What it checks

1. **`npm audit --json`** — fetches the npm advisory graph for the current
   `package-lock.json` and reports every vulnerable package with severity,
   range, advisory URL, and any fix version.
2. **`osv-scanner --lockfile=package-lock.json --format=json`** — cross-checks
   the same lockfile against the [OSV.dev](https://osv.dev) database. This
   surfaces advisories that npm's own database has not yet picked up.
   - If the `osv-scanner` binary is not on `PATH`, the check emits an
     `osv-scanner-not-installed` finding at `info` severity and continues.
     This is the common case on operator laptops; install
     [osv-scanner](https://google.github.io/osv-scanner/) when you want a
     second opinion locally. The CI workflow installs it on every run.
3. **Allowlist application** — `release-gate/supply-chain-allowlist.json`
   lists vulnerabilities that operators have explicitly accepted. Each entry
   carries an `id`, a `package`, a `reason`, and an `expires` date. A
   matching unexpired entry downgrades the finding from `high`/`critical` to
   `info`, records the match under `allowlistApplied`, and lets the check
   pass.

The verifier emits a single JSON report to stdout with the schema
`openclaw-frontier.supply-chain-advisory.v1` and exits 0 only when no
blocking findings remain.

## Adding an allowlist entry

Edit `release-gate/supply-chain-allowlist.json` and add an entry to the
`entries` array:

```json
{
  "schema": "openclaw-frontier.supply-chain-allowlist.v1",
  "entries": [
    {
      "id": "GHSA-xxxx-yyyy-zzzz",
      "package": "example-pkg",
      "reason": "Upstream fix lands in 1.2.4 next week; exploit requires attacker-controlled JSON path that we never expose.",
      "expires": "2026-06-15T00:00:00Z"
    }
  ]
}
```

### Discipline

Every entry must satisfy all of:

- **`id`** — a GHSA identifier (preferred) or OSV/CVE ID. The matcher is
  case-insensitive and also checks aliases reported by `osv-scanner`.
- **`package`** — the npm package name. This narrows the match so a GHSA ID
  shared across ecosystems only suppresses the relevant package.
- **`reason`** — a sentence in English that explains *why* the risk is
  acceptable right now. Examples that pass review:
  - "Upstream maintainer has tagged a fix; waiting for it to ship."
  - "Vulnerable code path is unreachable in our usage."
  - "Mitigated by network egress rules in `docs/security/`."
  Reasons like "false positive" without backing detail get rejected.
- **`expires`** — an ISO-8601 timestamp **no more than 90 days from when
  the entry is added**. The verifier treats expired entries as absent, so
  the gate re-locks automatically. Reviewers should reject any PR that
  extends an existing `expires` by more than 90 days without a new reason.

Once you have added the entry, re-run `npm run verify:supply-chain` and
confirm `ok: true` and that the finding appears under `allowlistApplied`.

## CI integration

The `.github/workflows/supply-chain-advisory.yml` workflow runs daily at
04:00 UTC and opens a labelled issue when blocking findings exist. To run
the same check inside another CI workflow, add a step:

```yaml
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install osv-scanner
        run: |
          OSV_VERSION="1.9.2"
          curl -fsSL -o /tmp/osv-scanner \
            "https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_linux_amd64"
          chmod +x /tmp/osv-scanner
          sudo mv /tmp/osv-scanner /usr/local/bin/osv-scanner

      - name: Run supply-chain advisory check
        run: npm run verify:supply-chain
```

Set `permissions: { contents: read, issues: write }` at the workflow level
if you also want the workflow to open issues on findings; otherwise
`contents: read` alone is enough to run the check.

## Local workflow

```sh
# Quick local check
npm run verify:supply-chain

# Run the unit tests (no network, no real npm audit, no osv-scanner needed)
npm run test:supply-chain
```

The unit tests pass fixture JSON to the verifier through the
`OPENCLAW_SUPPLY_CHAIN_NPM_AUDIT_FIXTURE` and
`OPENCLAW_SUPPLY_CHAIN_OSV_FIXTURE` environment variables. Those env vars
are only honoured by the verifier itself and never read by `npm audit` or
`osv-scanner`, so they are safe to set in test harnesses.

## Background

This check closes row 13 of `docs/reference-runtime-audit.md` — the
"Supply-chain advisory checker" gap. Before this gate, the package only
ran an informal `npm audit` inside the daily
`dependency-vulnerability-scan.yml` workflow, which fails *soft*. The
advisory checker fails *closed* and integrates with the release-gate
verifier so every release rebuilds proves it.
