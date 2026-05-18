# Security and governance lane

Status: SHIP as a production-safe eval, acceptance scenario, and policy lane.

Lane id: `FR-SECURITY-GOV-001`

This lane defines the release-safe security/governance controls expected of the Frontier package. It is intentionally synthetic: it uses placeholders, policy assertions, and local-only checks instead of live vault state, production approvals, or private incident records.

## Scope

The lane proves that a maintainer can reason about four governance surfaces without inheriting private runtime details:

1. secrets and vault policy checks;
2. no-public-secrets scanning before release;
3. two-agent/two-hardware quorum for high-risk operations;
4. approval gates and incident deductions in maturity scoring.

## Production-safe secrets and vault policy

The package must document secret handling as policy, not as data. Acceptable examples include:

- operator-supplied signing references such as `SecretRef: FRONTIER_SIGNING_KEY`;
- fake bus endpoints such as `nats://bus.example.invalid:4222`;
- synthetic fingerprints such as `SHA256:placeholder`;
- local-only acceptance scenario keys that are clearly marked as non-production fixtures.

The package must not include live credentials, private key blocks, OAuth files, registry tokens, personal paths, private hostnames, private IP addresses, raw logs, or runtime databases. Any real vault lookup, credential movement, or key rotation must stay outside this package and require operator action in the private runtime.

## No-public-secrets guard

`FR-SECURITY-GOV-001` adds a local verifier that scans the public lane artifacts for high-risk patterns and fails closed if any are found. The guard is intentionally conservative and is complementary to the existing package-wide private-content scan.

Required guard behavior:

- validate that the security governance docs and evidence files exist;
- require explicit policy language for vault placeholders, no-public-secrets scanning, quorum, approval gates, and incident deductions;
- reject private key blocks, common API token shapes, Telegram bot tokens, Slack tokens, private filesystem paths, and private IP patterns;
- emit a machine-readable report under `release-gate/reports/latest-security-governance-eval.json`.

## Two-agent / two-hardware quorum

High-risk operations require both role separation and hardware separation before they can proceed. A valid quorum requires:

- at least two distinct approving agents;
- at least two distinct hardware or host classes;
- no approval from a denied role;
- an approval reason bound to the candidate action.

Public acceptance scenario examples should use generic identities such as `sentinel-reviewer` on `host-a` and `release-reviewer` on `host-b`. They must not name private machines, accounts, or chat channels.

## Approval gates

The release path remains fail-closed. Passing automated checks does not authorize external publication. A high-risk operation can proceed only when all relevant gates are green:

| Gate | Requirement |
| --- | --- |
| Secret hygiene | no-public-secrets guard has zero findings |
| Quorum | two-agent/two-hardware approval is valid |
| Reviewer record | required reviewer decisions are present |
| License | release license is selected |
| Operator approval | explicit operator approval is recorded for the exact candidate and destination |
| Incident posture | open critical incidents block release; lesser incidents deduct score |

## Incident deductions

Security incidents reduce the maturity score even when the package remains acceptance scenario-safe. The local eval models deductions without using real incidents:

- critical open incident: block release;
- high-severity resolved incident: subtract 20 points;
- medium-severity resolved incident: subtract 10 points;
- low-severity resolved incident: subtract 5 points;
- missing incident review timestamp: subtract 5 points.

The score is a release-readiness signal, not an authorization. Publication still requires the approval gates above.

## Acceptance scenario command

Run from the package root:

```sh
node scripts/eval-security-governance.js
```

Expected result: the script prints JSON with `ok: true` and writes `release-gate/reports/latest-security-governance-eval.json`.

## Maintenance rule

Keep this lane generic. Add only placeholders, synthetic scenarios, and production-safe policy. Do not paste live secret names, incident logs, approval transcripts, account identifiers, private host labels, or raw runtime evidence into this package.
