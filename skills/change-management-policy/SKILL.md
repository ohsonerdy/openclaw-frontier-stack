---
name: change-management-policy
description: Use when defining or refining the policy that gates production changes — who can ship what, when review is required, what evidence the change must carry, and how the review actually happens. Triggers when the user mentions "change advisory board", "CAB", "change ticket", "change policy", "who needs to approve this", "change risk tiers", "do we need a freeze for this", "rubber-stamp approvals", or "we keep approving changes that break production". The skill covers risk-tiered approval rules, the evidence each tier requires, CAB anti-patterns (theater vs real review), and the emergency-change carve-out. For the deploy mechanics once a change is approved, see safe-public-release. For the post-incident review when an approved change broke production, see post-mortem-writing.
metadata:
  version: 0.1.0
---

# Change management policy

A change-management policy exists to catch the changes that will break production before they break production. Every well-meaning change-management policy degrades over time into one of two failure modes: (a) every change requires the same heavy review, the team routes around it, and the policy becomes theater, or (b) every change is rubber-stamped, real risks slip through, and the policy is decorative.

The fix is risk-tiered policy: the heaviest review applies to the riskiest changes, the lightest review applies to the routine ones, and the evidence required at each tier matches the actual risk. The policy's job is to allocate scarce attention — reviewer time, CAB time, executive time — to the changes that actually need it.

This skill covers the structure of a risk-tiered policy: how to define the tiers, what evidence each tier requires, who can approve at each tier, and the anti-patterns that turn the policy into theater. For the deploy itself, see safe-public-release.

## When to invoke this skill

- Writing a change-management policy for the first time.
- Auditing an existing policy that everyone routes around.
- Reviewing a specific change and deciding which tier applies.
- Investigating why a change broke production despite "going through CAB".
- Defining the emergency-change process (the carve-out for true incidents).
- Onboarding a new engineer who is about to ship their first production change.

## Risk tiers

Most policies need exactly four tiers. Fewer tiers and the policy can't discriminate between routine and risky. More tiers and reviewers can't keep them straight.

- **Tier 1 — Standard.** Pre-approved changes. The team has done this category of change many times, the rollback is well-understood, the blast radius is bounded. Examples: scaling a stateless service within a defined range, deploying a backend change behind a feature flag, rotating a non-production secret, applying a documented runbook step. Approval: the author plus one peer reviewer in the codebase. No separate ticket.
- **Tier 2 — Normal.** Changes that affect a single service or component, with a known rollback path and a non-shared blast radius. Examples: schema change with expand-contract, library upgrade with tests passing, config change to a non-critical setting, deploy of a new feature behind a flag. Approval: code review plus service owner sign-off. Change ticket required, with the standard evidence (test results, rollback plan, deploy window).
- **Tier 3 — Major.** Changes that affect multiple services, shared infrastructure, or a critical user journey. Examples: change to authentication, change to the primary database, change to the payments path, major dependency upgrade, infrastructure migration. Approval: service owner plus CAB review with named reviewers (not just a queue). Evidence: full test plan, rollback plan tested in staging, load test results if applicable, deploy window with on-call coverage.
- **Tier 4 — Emergency.** Changes made to mitigate an active incident, where the normal review process would extend user impact. Examples: rolling back a bad deploy, disabling a feature flag during an outage, scaling up to mitigate a load spike, applying a hotfix for a sev 1 bug. Approval: incident commander authorizes; full review happens after the change. Evidence: post-change retrospective within 48 hours, full review captured in the incident post-mortem.

The tier is a property of the change, not the team. The same team can ship tier 1 and tier 3 changes in the same week.

## How to assign a tier

The tier is determined by answering four questions about the change:

1. **What is the blast radius if it goes wrong?** Single user, single tenant, single region, all users, all data.
2. **What is the rollback path, and is it tested?** Reversible in seconds, reversible in minutes, reversible with effort, irreversible.
3. **What is the user-visible impact if rollback is needed?** None, brief degradation, partial outage, full outage.
4. **What is the team's familiarity with this category of change?** Done dozens of times, done a few times, first time for this team.

If all four answers are at the low end, tier 1. If any answer is at the high end (irreversible, full outage, first-time), the tier escalates accordingly.

Anti-pattern: assigning the tier based on the size of the diff. A one-line config change can be tier 3 if it routes traffic. A 500-line refactor can be tier 1 if it's behind a flag with a tested rollback. Tier is about risk, not lines of code.

## Evidence per tier

The evidence requirement scales with the tier. The principle: the heavier the change, the more the author has to prove ahead of time.

- **Tier 1 (Standard).** Code review approval. Tests pass. Deploy via the standard pipeline.
- **Tier 2 (Normal).** All of tier 1, plus: a written rollback plan (one paragraph, not a hand-wave), the deploy window (when and on-call coverage), service owner sign-off in the ticket.
- **Tier 3 (Major).** All of tier 2, plus: a tested rollback (rollback executed against staging, not just described), a load or migration plan if applicable, named CAB reviewers with their concerns recorded, a defined abort criterion ("if X happens within Y minutes, abort and roll back").
- **Tier 4 (Emergency).** Authorization from the incident commander, recorded in the incident channel. Post-change retrospective within 48 hours. The retrospective is the substitute for pre-change review.

Anti-pattern: tier 2 changes that ship with no written rollback plan because "we'll figure it out if it breaks". The rollback plan written under pressure is worse than the one written in advance.

## Who approves at each tier

The approver list is part of the policy. Vague approvers ("a senior engineer") lead to nobody actually approving.

- **Tier 1.** Peer reviewer in the codebase. Named in the PR.
- **Tier 2.** Service owner. Named in the service registry. The service owner cannot be the author.
- **Tier 3.** CAB. The CAB is a named rotation of senior engineers and SREs, not a queue. Two reviewers per change minimum, with their concerns and sign-offs recorded.
- **Tier 4.** Incident commander. Named in the incident.

The author is never the sole approver. The service owner cannot approve their own change.

Anti-pattern: "anyone with merge rights can approve". This leads to authors approving their own changes by way of self-reviewing a tiny commit on top.

## CAB anti-patterns: theater vs real review

The CAB exists to catch tier 3 risks before they ship. It fails for predictable reasons.

- **The rubber-stamp CAB.** Every change is approved within five minutes because the reviewer hasn't read it. The CAB is decorative. Fix: require the CAB reviewer to record their specific concerns or sign-off rationale. "Approved" with no rationale is not an approval.
- **The bottleneck CAB.** Every tier 2 change is sent to CAB, the queue is days deep, the team starts marking tier 3 changes as tier 1 to skip the queue. Fix: enforce the tier definition strictly, and trust the tier 2 service-owner review.
- **The blame CAB.** The CAB exists so that when a change breaks production, the team can point at "but CAB approved it". This shifts blame but doesn't catch the bad change. Fix: the policy explicitly says the CAB is a review, not a guarantee. The service owner remains accountable.
- **The vibes CAB.** The CAB approves based on tone of the change ticket ("looks well-written") rather than the evidence. Fix: the evidence checklist is explicit; the CAB checks the boxes, not the prose.
- **The same-people CAB.** Two senior engineers sit on every CAB call and burn out. Fix: rotation, with at least four people on the CAB roster, each on a defined cadence.

The signal that the CAB is real: the CAB sometimes rejects changes, asks for more evidence, or suggests splitting a change into phases. A CAB that has never rejected a change is theater.

## Emergency-change carve-out

The emergency carve-out exists because waiting for tier 3 review during an active incident extends user impact. The carve-out has to be tight so it doesn't become the default.

The carve-out criteria:

- **There is a declared incident.** Without a declared incident, it's not an emergency change.
- **The change is the mitigation.** Not a feature, not an unrelated improvement.
- **The incident commander authorizes.** Named, in the incident channel, with timestamp.
- **The post-change review is mandatory.** Within 48 hours, captured in the post-mortem. The review includes: was this really an emergency, would the change have passed tier 3 review, is there a process improvement needed.

Anti-pattern: marking routine changes as emergency to skip review. The post-incident review should catch this; if it doesn't, the carve-out has become a loophole.

## Freezes and windows

Some change windows are too risky for normal-tier changes. The policy names them.

- **Deploy freeze.** Periods of no non-emergency changes: end-of-quarter financial close, week of a major launch, week of a major customer event, holiday weekends. The freeze is named and dated in advance.
- **Off-hours deploys.** Tier 3 changes default to off-peak windows with on-call coverage. The policy defines what "off-peak" means per region.
- **Friday rule.** Tier 3 changes on Friday afternoon are an anti-pattern (weekend on-call inherits the risk). The policy can name "no tier 3 deploys after noon Friday local time" as a default that requires explicit exception.

The freeze is enforced by the policy, not by goodwill. The standard pipeline rejects tier 2 and tier 3 changes during the freeze window unless they carry an emergency authorization.

## Audit trail

Every approved change should leave a record that the post-incident investigation can read.

- **Tier 1.** PR with review approval. Linked to the deploy.
- **Tier 2.** Change ticket with rollback plan, deploy window, service owner approval. Linked to the PR and the deploy.
- **Tier 3.** All of tier 2, plus CAB sign-offs with rationale, tested rollback evidence, abort criteria.
- **Tier 4.** Incident channel record of the authorization, plus the post-change retrospective.

The audit trail is not for auditors; it's for the next engineer investigating an incident that traces back to this change. If the trail is missing, the investigation has to reconstruct what happened from memory, which is unreliable.

## Common anti-patterns

- **One-tier policy where everything needs CAB.** The team routes around it. Policy becomes decorative.
- **Tier assigned by diff size, not risk.** The wrong changes get the heavy review.
- **CAB approves without rationale recorded.** Approvals are unverifiable.
- **Service owner approves their own changes.** No second pair of eyes.
- **Emergency-change carve-out used for routine changes.** The carve-out becomes the default.
- **No tested rollback for tier 3.** "Rollback plan" is a paragraph that nobody verified.
- **No abort criteria for tier 3 deploys.** Deploy goes wrong, team improvises.
- **Friday tier 3 deploys with no exception process.** Weekend on-call inherits the risk.
- **Freeze windows that nobody enforces.** The policy says "no deploys week of launch" and then nobody blocks the deploy.
- **CAB that has never rejected a change.** Either the team writes flawless changes (unlikely) or the CAB is theater.

## Output format

When this skill is invoked to write or audit a change-management policy, structure the output as:

1. **Tier definitions** — the four tiers with examples per tier.
2. **Tier assignment rule** — the four-question test for assigning a tier to a specific change.
3. **Evidence requirements** — what each tier must produce before approval.
4. **Approver list** — named approvers or rotations per tier.
5. **Emergency-change carve-out** — criteria, authorization, post-change review.
6. **Freezes and windows** — when normal changes are paused.
7. **Audit trail** — what record each tier leaves behind.
8. **Anti-patterns to watch for** — the specific failure modes the policy should resist.

## Related skills

- `safe-public-release` — the deploy mechanics once a change is approved.
- `incident-response` — the playbook when a change breaks production.
- `post-mortem-writing` — the review of what happened, including whether the change-management policy caught or missed the issue.
- `oncall-rotation-design` — the rotation that absorbs the on-call impact of changes.
- `disaster-recovery-exercise-design` — periodic exercises that test whether the rollback paths actually work.
- `feature-flagging` — the flag-based pattern that lets many changes be safer (lower tier) than they otherwise would be.
