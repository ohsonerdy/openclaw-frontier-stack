---
name: service-ownership-boundaries
description: Use when drawing the line between services, deciding whether a feature lives inside an existing service or becomes its own, or untangling who owns what when an outage exposes ambiguous ownership. Triggers when the user mentions "bounded context", "service boundaries", "split this service", "merge these services", "Conway's law", "team topology", "who owns this code", "should this be a new service", "microservice vs monolith", "shared service vs library", or "the post-mortem said nobody owned the failing component". The skill covers bounded contexts, Conway's law in practice, the split-vs-merge decision, ownership vs maintenance, and the anti-patterns that arise when ownership boundaries don't match the technical or organizational shape. For the change policy that operates over the boundaries, see change-management-policy. For the deploy mechanics within a service, see safe-public-release. For the runbook ownership that follows service ownership, see runbook-writing.
metadata:
  version: 0.1.0
---

# Service ownership boundaries

A service boundary is two things at once: a technical interface (this code calls that code via this contract) and an organizational interface (this team owns that, the other team owns the other). The healthy systems are the ones where the two boundaries line up. The painful systems are the ones where the technical and organizational shapes drift apart, so the on-call gets paged for code they don't understand and the team that wrote the code is two layers away from the incident.

The discipline of service ownership is to draw boundaries that hold up over years, where each service has one team that can answer "what is this for, what does it do, and what happens when it breaks?" without conferring with three other teams. Boundary drift is normal; what matters is noticing it and either redrawing the boundary or moving the ownership.

This skill covers bounded-context thinking, Conway's law and reverse-Conway maneuvers, the split-vs-merge decision rule, the difference between ownership and maintenance, and the failure modes when boundaries are wrong. For the policy that gates changes across service boundaries, see change-management-policy.

## When to invoke this skill

- Designing the service shape for a new domain.
- Deciding whether a new capability is a feature in an existing service or a new service.
- Reorganizing teams and figuring out which services move with which team.
- Triaging an incident where the on-call doesn't know who owns the failing component.
- Auditing the service catalog to find the orphans and the over-burdened owners.
- Splitting a monolith that has grown past one team's cognitive load.
- Merging two services that were split too early and now thrash each other.
- Reviewing an architecture proposal that adds a new service to the catalog.

## Bounded contexts

A bounded context is the area of the domain where the same words mean the same things and the same data has the same shape. Inside the context, `Order` is one schema, one set of states, one lifecycle. Outside the context, `Order` might mean something different — a different schema, a different state machine, a different team's mental model.

The decision rule for a service boundary: a service should align with a single bounded context. When two distinct concepts collapse into one service ("Order" used by both billing and fulfillment, with different fields and lifecycles), the service grows internal contradictions that the team navigates with comments and prayer.

Symptoms that a single service is straddling two bounded contexts:

- Two distinct teams keep wanting different things from the same model.
- The model has fields that only some endpoints use.
- The lifecycle ("when does this transition to that state?") has conditional logic per consumer.
- The team that owns the service has to deeply understand two unrelated domains.

When you find this, the fix is usually to split. The boundary lines up with the conceptual seam: one context becomes one service, the other becomes another, and there's an explicit translation at the seam (the "anti-corruption layer" in Eric Evans's terminology).

Anti-pattern: drawing service boundaries around technical concerns ("the database service", "the auth service") without checking whether they map to bounded contexts. The technical service that crosses contexts becomes a coordination bottleneck.

## Conway's law in practice

Conway's law: organizations design systems whose structure mirrors the organization's communication structure. Stated more usefully for design: the team boundaries you have today will show up as service boundaries whether you want them to or not.

The two ways to use this:

- **Forward-Conway.** Accept the team shape and design services that match. If three teams own three areas of the domain, draw three service boundaries that match. Don't fight the org chart with architecture; the architecture will lose.
- **Reverse-Conway.** Decide on the architecture you want first, then reshape the teams to match. If the right architecture has four services and you have three teams, change the team shape before drawing the service shape.

The decision rule: if the architecture is a re-org in disguise, do the re-org explicitly. If the architecture is constrained to the current team shape, accept the constraint and design to it. The painful path is pretending the team shape doesn't matter; it always does.

Anti-pattern: drawing a beautiful four-service architecture that requires four teams when you have two. Six months later the two teams own four services unevenly, two of which are unloved.

## The split-vs-merge decision

The most common architectural question: should this be one service or two?

Splitting is right when:

- **Two distinct bounded contexts have crept into one service.** The team is now maintaining two unrelated domains in one codebase. Splitting reduces cognitive load.
- **Two distinct teams own different parts of one service.** The shared codebase is a coordination bottleneck; every PR needs cross-team review. Splitting aligns ownership with code.
- **The deploy cadences are different.** One area needs to deploy ten times a day; the other deploys monthly. The mixed cadence forces the slower part to deploy faster or the faster part to deploy slower. Splitting decouples cadence.
- **The scaling shape is different.** One workload is CPU-bound and steady; the other is bursty and memory-bound. Mixing them on one fleet wastes resources.

Merging is right when:

- **Two services share the same data and team, with no real isolation.** They were split because of an architectural fashion, not a real boundary. Merging removes the inter-service call and the coordination overhead.
- **Two services are always changed together.** Every feature requires a coordinated deploy across both. The split was theater.
- **Two services share an on-call rotation and the responder is paged for the wrong service half the time.** The fault attribution between them is unclear because they're really one system.

The default bias depends on where you are:

- **Early stage, few services.** Bias toward not splitting. A single service with internal modules is easier to operate than two services that don't yet have their boundary right.
- **Late stage, many services with overload.** Bias toward not adding more. Look for merges or consolidations that reduce the operational surface area.

Anti-pattern: splitting because the codebase is "too big" without confirming there's a real boundary inside. A 50,000-line codebase that's one bounded context is one service. Splitting it by file count creates two services with a chatty interface.

## Ownership vs maintenance

Ownership and maintenance are different responsibilities. A team can own code without being the only ones who change it; a team can maintain code (keep it running, respond to its pages) without being the original authors.

- **Ownership.** Responsible for the design, the roadmap, the API contract, and the strategic direction. Owners decide what the service is for and where it goes.
- **Maintenance.** Responsible for keeping the service running, responding to its alerts, and applying routine updates. Maintainers may or may not be on the owning team.
- **Inner-source contribution.** Other teams may submit PRs to a service they don't own; the owning team reviews and decides whether to merge.

The healthy default: the owning team is also the maintainer. The service catalog lists one team per service, and that team is paged for the service's alerts.

Exceptions where ownership and maintenance separate:

- **Platform services.** A platform team owns the design of (say) the deploy system; service teams may maintain the parts of it that are configured for their service. The platform team owns the contract; the service team operates within it.
- **Legacy ownership during transition.** When a service is being transferred from one team to another, the old team maintains it while the new team learns it. The transition has a defined end date.
- **Service-on-loan.** A team that built a service is rotated off; the service goes to a sustaining team. The original team can be consulted but isn't on-call.

Anti-pattern: a service that's on three different teams' on-call rotations because each thinks the others own it. Every page triggers a "who is this?" hunt before anyone starts diagnosing.

## The orphan service

The orphan is the service that nobody actively owns. It runs, it sometimes fires alerts, the alerts go to a team that touched it once two years ago and don't really know it anymore. The orphan is a tail risk: it works until it doesn't, and when it breaks, nobody can diagnose it.

Sources of orphans:

- The original team was reorganized; the service was not explicitly transferred.
- The service was built as a side project, deployed, and forgotten.
- A vendor integration was wrapped in a service that nobody continued to invest in.

The triage for an orphan:

- **Find the actual usage.** Is the service still receiving traffic? From whom? Is it on the critical path of any user-facing feature?
- **Assess the cost of letting it die.** If usage is zero, deprecate and remove. If usage is non-critical and small, consider retiring after a notice period.
- **If keeping it, assign a real owner.** Not "the platform team takes everything" — a specific team with a charter that includes this service.
- **If the assignment is unfair, fund it.** Adding a service to a team's portfolio without staffing is how the next set of orphans is created.

Anti-pattern: putting every orphan on the platform team. The platform team becomes a graveyard of unowned services; its real work suffers.

## Shared services and chatty boundaries

When two services need to communicate often, they become coupled even if the interface is "well-defined". Signs of a chatty boundary:

- A single user request crosses the boundary more than two or three times.
- The two services need to be deployed together to roll out a feature.
- The two services share an on-call rotation because one fails when the other does.
- The two services share an internal client library that hides the cross-service call.

The chatty boundary is a sign the split was wrong. Either the boundary is in the wrong place (the real bounded context contains both), or the protocol is wrong (batched calls, event-driven instead of request-response).

Decision rule for a new cross-service call: count the calls per user request. If the answer is more than two or three, reconsider the boundary or the protocol before merging the call into the request path.

## The over-shared library

Sometimes the right answer to "do we split this service?" is "extract the shared logic into a library that both services use, but don't make a third service for it". A library is cheaper than a service: no network, no deploy, no on-call.

When a library is right:

- The shared logic has no state of its own (it's a computation, a parser, a validator).
- Updates to the logic can ship with the consuming service's deploy.
- The interface is stable enough that consumers can pin to a version.

When a service is right instead of a library:

- The shared logic has its own state or its own data source.
- The logic needs to evolve independently of consumer deploys.
- The logic has a different scaling shape from consumers.
- Multiple consumers each take a hard dependency that needs central enforcement (e.g., feature flag evaluation, auth tokens).

Anti-pattern: extracting a library for everything shared. The library becomes the new monolith, every consumer needs to upgrade in lockstep, and the supposed isolation never materialized.

## Service catalog hygiene

The service catalog is the team's source of truth for who owns what. A healthy catalog has, per service:

- **Service name.** Stable identifier used in metrics, logs, traces, alerts.
- **Owning team.** Single team name, not a person.
- **Tier or criticality.** How user-visible an outage is.
- **On-call rotation.** Where the page goes.
- **Repository link.** Where the code lives.
- **Runbook link.** Where the operational playbook lives.
- **Dependencies.** What this service calls; what calls this service.
- **Last-reviewed date.** So stale entries are visible.

The catalog is reviewed quarterly. Services with missing owners are reassigned or deprecated. Services with stale last-reviewed dates trigger a re-walk. The catalog is the artifact that prevents orphans from accumulating silently.

Anti-pattern: the catalog exists but is months out of date. The team that gets paged for a service it doesn't own discovers the catalog has them listed as owner from a previous reorg.

## Splitting a monolith

Splitting a monolith is a large undertaking and is its own skill, but the decision rule for whether to split is in scope here.

A monolith should be split when:

- The team that owns it has grown past the cognitive load (commonly two pizza teams or more sharing one codebase).
- The deploy cadence is dictated by the slowest part; faster-moving areas are blocked by riskier areas.
- The blast radius of a single bad deploy affects the whole organization.
- The bounded contexts inside it are clear; the seams are identifiable.

A monolith should not be split when:

- The team is one team, the cognitive load is manageable, and the monolith is the simpler operational shape.
- The seams aren't clear yet; the split would create cross-service chatter that doesn't reduce coordination.
- The team is small and a service-per-context fragmentation would create more on-call burden than the monolith.

The decision is not "monoliths are bad" or "microservices are good"; it's whether the team shape and the domain complexity have outgrown the single service.

## Common anti-patterns

- **Service boundary that crosses a bounded context.** The model has internal contradictions per consumer.
- **Service that no one team owns.** Pages go to confused responders; nobody can diagnose.
- **Beautiful architecture that the team shape can't support.** The org chart wins; the architecture decays.
- **Splitting because the codebase feels big, not because there's a real boundary.** Two services with chatty interface, no isolation gain.
- **Merging two services because one is failing, without addressing why.** The failure mode is now inside the merged service.
- **Library that should have been a service.** Lockstep upgrades; no isolation.
- **Service that should have been a library.** Network call, on-call, extra deploy for what could have been a function.
- **Catalog out of date.** Page goes to wrong team; orphans hide in plain sight.
- **Every shared concern becomes a service.** The catalog grows to hundreds of services; operational load swamps the value of isolation.
- **Reorg that doesn't move the services with the people.** Old team still maintains code they no longer have time for.

## Output format

When this skill is invoked to design, audit, or fix a service boundary, structure the output as:

1. **Bounded-context map.** What domain areas exist; what model and lifecycle each owns; where the seams are.
2. **Team-to-service mapping.** Which team owns which service; identify orphans and over-burdened owners.
3. **Conway alignment.** Does the architecture match the team shape, or does one need to change for the other.
4. **Split-vs-merge recommendation per service in question.** With reasoning grounded in cognitive load, deploy cadence, scaling shape, and team shape.
5. **Ownership vs maintenance.** Who owns the design vs who keeps it running. Default to same team; flag exceptions.
6. **Catalog updates.** Service catalog entries that need creation, reassignment, or deprecation.
7. **Transition plan.** If a service is being split, merged, or transferred, the sequence and the end date.

## Related skills

- `change-management-policy` — the change policy assumes clear ownership; ambiguous ownership defeats the tier-assignment process.
- `runbook-writing` — runbooks are owned per service; ownership drift creates runbook orphans.
- `oncall-rotation-design` — the rotation maps to the owning team; misaligned ownership creates misrouted pages.
- `incident-response` — the responder needs to know who owns the failing component before mitigating.
- `architecture-decision-records` — the ADR is where the boundary decision is documented and revisited.
- `safe-public-release` — the deploy mechanics operate per service; boundaries determine deploy independence.
- `oncall-handoff-rituals` — the handoff between shifts depends on which services the rotation covers.
- `local-dev-environment` — service boundaries determine what runs in local dev and how composition works.
