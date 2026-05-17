# Public release boundaries

Status: SHIP as the package boundary contract.

This package is a reusable OpenClaw full-stack architecture blueprint. It must describe patterns, interfaces, templates, and synthetic examples only. It must not carry operator-private runtime state.

## Allowed content

- Architecture docs for signed bus, blackboard, taskflow, memory adapters, skill forge, integration adapters, and Mission Control sidecars.
- Local-only demos with synthetic agents, synthetic keys, and generated temporary output.
- Templates that use placeholders for endpoints, agent ids, and reviewer names.
- Release-gate reports that summarize verification status without raw logs.
- Runbooks that describe diagnostic order and evidence shape without exposing live infrastructure.

## Excluded content

Do not include credentials, tokens, OAuth files, private keys, personal memory files, transcripts, chat identifiers, client context, personal-domain content, real hostnames, real IP addresses, private filesystem paths, raw logs, session databases, vector stores, backups, personal scheduled jobs, or machine-specific service state.

## Placeholder policy

Use stable placeholders instead of live values:

| Need | Placeholder example |
| --- | --- |
| Bus endpoint | `nats://bus.example.invalid:4222` |
| Agent id | `agent-alpha` |
| Host label | `host-a` |
| Public key fingerprint | `SHA256:placeholder` |
| Local path | `/path/to/repo` |
| Reviewer | `reviewer-name` |

## Pre-upload operator checks

Before any upload, the operator must confirm:

1. Root `LICENSE` has been chosen and added.
2. Reviewer decision files for required roles are present.
3. `release-gate/reports/latest-verification.json` reports `ok: true`.
4. Clean export was regenerated after the last content change.
5. No external publish, push, announcement, or credential movement is implied by verification.
6. The release status still treats upload as blocked until explicit operator approval is recorded.

## Maintainer rule

When in doubt, keep the public package generic and record private operational evidence outside the package. The public blueprint should be enough for a maintainer to understand and reproduce the architecture without inheriting the original operator's secrets or private runtime history.
