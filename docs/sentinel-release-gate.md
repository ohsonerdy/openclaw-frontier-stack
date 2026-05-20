# Security release gate

The Security reviewer is the security/reputation reviewer for OpenClaw Frontier Stack. Sentinel can approve a package for review, but Security approval is not the same as public upload authorization.

## Gate states

| State | Meaning |
| --- | --- |
| `MISSING` | Evidence or reviewer decision not yet present. |
| `BLOCK` | A safety, reputation, completeness, or correctness issue must be fixed. |
| `APPROVE_RELEASE_CANDIDATE` | Safe for production release when all gates pass. |
| `APPROVE_RELEASE_CANDIDATE` | Safe to present to the operator for final upload decision. |
| `OWNER_APPROVED_UPLOAD` | the operator explicitly authorized GitHub upload. |

## Required checks before release candidate

1. **No external publish** — no GitHub push, package upload, remote announce, or tag creation during preparation.
2. **Clean package only** — package source comes from `./` or later clean-room export, not live runtime roots.
3. **Scanner pass** — pattern scan finds no credentials, private paths, hostnames, personal identifiers, client context, raw logs, session DBs, vector stores, backups, or excluded agent domains.
4. **Acceptance scenario pass** — swarm and memory acceptance scenarios run locally using synthetic data only.
5. **Mission Control operator-safe** — board acceptance scenario uses fake tasks, fake agents, fake artifacts, dry-run writeback only.
6. **Docs complete** — README, release scope, bus/blackboard, memory, TaskFlow, trace, Mission Control, and release gate docs exist.
7. **4/4 review** — Architecture, Security, Operations, and Release each record APPROVE/BLOCK/MISSING.
8. **Owner upload approval** — the operator explicitly says to upload/publish.

## Reputation checks

The Security reviewer should block if the package reads as any of these:

- personal AI companion dump;
- private life/workstation export;
- minimal chatbot collection;
- client/internal company data leak;
- trading or hobby-agent release;
- tool logs/session transcripts dressed as architecture;
- impressive acceptance scenario with hidden credentials or unreproducible local assumptions.

The Security reviewer should approve only if the package reads as:

> A professional production architecture for coding swarms with shared state, memory, task ownership, observability, and release gates.

## Reviewer decision record

Each reviewer should record:

```yaml
reviewer: Security
version: <candidate version>
decision: APPROVE_RELEASE_CANDIDATE | APPROVE_RELEASE_CANDIDATE | BLOCK | MISSING
scope: <what was reviewed>
evidence:
  - <artifact path or command output>
conditions:
  - <remaining required conditions>
notes: <short human-readable summary>
```

## Non-bypass rule

No single agent can bypass the gate. A technically clean scanner result is necessary but not sufficient. Reputation, completeness, and owner intent are separate checks.
