---
name: threat-modeling
description: Use when systematically identifying threats to a new system, feature, or significant architectural change. Triggers when the user mentions "threat model", "STRIDE", "attack surface", "what could go wrong", "security architecture", "threat assessment", or "what's our trust boundary". The output is a structured list of threats organized by data flow with mitigation strategies tied to each. For diff-level review against a specific change, see security-review. For capturing the resulting decisions, see architecture-decision-records.
metadata:
  version: 0.1.0
---

# Threat modeling

A threat model is a structured exercise to find what could go wrong with a system before it's running in production. Security review is for code; threat modeling is for design. The two complement each other — a sound design that's implemented carelessly is still insecure, and careful implementation of an unsound design is at most narrowly secure.

The skill is to think systematically about adversaries — not just "what bugs might we have" but "if I were trying to attack this, where would I push, what would I break, what would I gain".

## When to threat-model

- Designing a new system or feature that handles sensitive data or actions.
- Significantly changing an existing system's trust boundaries (new external integrations, new user types, new privilege levels).
- After a series of related security incidents — the systemic question they raise.
- Before a major release to a wider audience.
- When introducing new infrastructure (multi-tenancy, new auth mechanism, new payment flow).

For small features within an established system whose threat model is well-documented, you don't need a full re-threat-model. Update the existing one if anything material changed.

## Step 1: define what you're modeling

Threat modeling has a scope. State it explicitly.

- **System boundary.** What's in scope (the feature/system being modeled) and what's out (other systems it talks to, but isn't this exercise's subject).
- **Data sensitivity.** What kinds of data does this system handle? PII, financial, credentials, health, regulated? Different sensitivity classes raise different concerns.
- **User classes.** Who interacts with the system? Anonymous visitors, authenticated users, admins, partners, internal staff. Each class has different trust levels.
- **Assets at risk.** What does the attacker want? Data, money, compute, reputation, lateral access to other systems.

The scope determines what threats you focus on. A public-internet system has different concerns than an internal corporate tool.

## Step 2: build the data flow diagram

The foundation of threat modeling is a data flow diagram (DFD). The DFD shows:

- **Entities** (users, services, third parties) as squares or external boxes.
- **Processes** (your code that handles data) as circles.
- **Data stores** (databases, caches, files) as parallel lines or cylinders.
- **Data flows** (the arrows between everything) showing direction.
- **Trust boundaries** as dashed lines crossing the diagram, separating zones of different trust.

The DFD doesn't need to be visually polished. A bullet-tree or a markdown table works. What matters is that every data flow is identified and every trust boundary is marked.

A trust boundary is wherever data passes from a less-trusted zone to a more-trusted zone, or vice versa. Common ones:

- Public internet to your edge (user input enters the system).
- Authenticated user to your application logic (the verified-identity boundary).
- Application to database (where queries become privileged operations).
- Service to service (where one service trusts another's claims).
- Your system to a third-party API (outbound trust).

Each trust boundary is where attacks happen. Threats below get attached to specific boundaries.

## Step 3: apply STRIDE per data flow

STRIDE is a checklist of threat categories. For each data flow in the DFD, ask whether each category applies.

### S — Spoofing

Can the source of a request be faked? Can an attacker pretend to be another user, another service, another component?

Examples:
- A request claims to be from user X. Is the identity verified?
- A service-to-service call presents a credential. Is it bound to the calling service?
- A webhook from a third party. Is the signature verified?

Mitigations: authentication, mutual TLS, signed payloads, capability tokens.

### T — Tampering

Can the data in transit or at rest be modified by an unauthorized party?

Examples:
- A request body is modified in transit. Is integrity protected (TLS, signatures)?
- A row in the database is modified by an unauthorized writer. Is access controlled?
- A configuration file is modified between deploys. Is integrity verified?

Mitigations: TLS, message signing, database access controls, immutable infrastructure.

### R — Repudiation

Can a user or service deny that they performed an action when in fact they did?

Examples:
- A user disputes a transaction. Do logs show the user's verified identity, the action, the time, and the source IP?
- An admin makes a privileged change. Is the action attributable to a specific account?

Mitigations: audit logging with strong identity binding, log integrity (append-only, write-once).

### I — Information disclosure

Can data be exposed to parties who shouldn't see it?

Examples:
- Error responses leak internal state.
- Side channels (timing differences, response size differences) reveal information.
- Logs contain sensitive data accessible to engineers who shouldn't see it.
- Encryption keys are exposed.
- Cached data is shared across tenants.

Mitigations: data classification, access controls, log hygiene, side-channel-resistant comparisons (constant-time), encryption.

### D — Denial of service

Can the system be made unavailable through resource exhaustion or targeted disruption?

Examples:
- An expensive endpoint is reachable without authentication. Attacker hits it repeatedly.
- A request can trigger a large amount of work (image processing, regex, database query).
- A user can fill a queue or storage by submitting many requests.
- A single user can degrade service for all users.

Mitigations: rate limiting, request budgets, timeouts, per-user quotas, circuit breakers.

### E — Elevation of privilege

Can an attacker do something they're not supposed to do?

Examples:
- A regular user accesses admin endpoints.
- A tenant accesses another tenant's data.
- A user can call internal-only endpoints.
- A bug in deserialization allows code execution.

Mitigations: layered authorization, defense in depth, least privilege, principle of complete mediation.

For each data flow, walk STRIDE and note which threats apply, which are mitigated, and which need new controls. Most flows have multiple STRIDE entries; that's expected.

## Step 4: the abuser story

Mirror of the user story. For each user story ("As a user, I want to X so that Y"), write the abuser story ("As an attacker, I want to abuse X to achieve Z").

Examples:

- User story: "User uploads a profile photo."
  - Abuser story: "Attacker uploads a malicious file to gain RCE on the server."
  - Abuser story: "Attacker uploads a giant file to consume storage."
  - Abuser story: "Attacker uploads a file referencing a private internal URL (SSRF)."
  - Abuser story: "Attacker uploads a polyglot file that's a valid image and a valid HTML page."

- User story: "User resets their password by email."
  - Abuser story: "Attacker enumerates valid emails via the reset endpoint."
  - Abuser story: "Attacker resets someone else's password by predicting the reset token."
  - Abuser story: "Attacker triggers many password resets to spam a target."
  - Abuser story: "Attacker resets, then waits for the legit user to click the email (which now contains the attacker's reset link)."

Each abuser story is a candidate threat. Triage to find the ones worth mitigating.

The abuser story is a complement to STRIDE, not a replacement. STRIDE is exhaustive but abstract. Abuser stories are concrete but may miss categories that didn't occur to the writer.

## Step 5: build the attack tree

For high-stakes assets, decompose the attack top-down.

The root of the tree is the attacker's goal: "Read another user's data". The branches are ways to achieve it. Each branch decomposes into more specific paths.

Example:

```
Goal: Read another user's data
├─ Direct access via API
│   ├─ Bypass authorization check
│   │   ├─ Find an endpoint missing the check
│   │   ├─ Find an authz check that uses client-controlled data
│   │   └─ Find a privilege confusion (user-as-admin)
│   └─ Reuse another user's session
│       ├─ Steal session token (XSS, network sniffing, log leak)
│       └─ Predict session token (weak randomness)
├─ Indirect access via database
│   ├─ SQL injection
│   ├─ Direct DB connection (credential leak)
│   └─ Backup file exposure (storage misconfig)
└─ Side-channel
    ├─ Timing comparison reveals existence
    ├─ Cache poisoning serves cached data to attacker
    └─ Log file contains data attacker can read
```

The tree is for prioritization. The branches with shortest paths and highest reward are where attackers go. Mitigate those first.

## Step 6: threat vs vulnerability vs risk

Keep the terms straight; teams that mix them produce confused threat models.

- **Threat.** A potential adverse event. "An attacker steals session tokens."
- **Vulnerability.** A weakness that enables a threat. "Session tokens are sent in URL parameters and logged."
- **Risk.** The probability of the threat being realized times the impact. "Logged session tokens, high-value session, regulated industry — high risk."

A threat without a vulnerability is theoretical. A vulnerability without a threat is unlikely to be exploited. A risk is the multiplier — high threat probability and high impact is high risk.

Threat modeling produces threats. Vulnerabilities are discovered during implementation review (security review) or testing (pen test). Risks are the management view of how much to invest in mitigation.

## Step 7: likelihood and impact

For each threat, score:

- **Likelihood.** How probable is this exploitation? Considers attacker capability, prevalence of the attack class, exposure (public internet vs internal network), and existing controls. Coarse buckets: low/medium/high.
- **Impact.** What's the damage if successful? Data exposed, money lost, compliance violation, reputation harm. Coarse buckets: low/medium/high.

Risk = likelihood × impact. Prioritize mitigation by risk, not by ease of mitigation. The trap is to fix the easy threats (which are usually lower risk) and leave the hard threats unaddressed.

Be honest about likelihood. "Sophisticated attacker" is a real category for high-value targets. "Script kiddie running automated scanners" is a common attacker against any public system. Different mitigation strategies for each.

## Step 8: mitigation taxonomy

For each significant threat, choose one or more controls. Four bucket model:

- **Prevent.** Stop the attack from succeeding. Input validation, authentication, encryption. Best when feasible.
- **Detect.** Notice when the attack happens. Monitoring, anomaly detection, audit logging. Necessary because prevention is never complete.
- **Respond.** Contain the attack once detected. Incident response, isolation, rate limit / shutdown. Pre-plan, don't improvise.
- **Recover.** Restore from the attack. Backups, immutable artifacts, replay capability.

A serious threat needs at least prevent and detect. Single-layer defenses fail.

## Step 9: who attacks us and why

Not all attackers are equal. Brief profiles inform what to defend against.

- **Opportunistic.** Automated scanners hitting any public IP. Cheap to defend against (patching, basic hygiene). Common against any public system.
- **Targeted external.** Adversary with specific interest in your system or sector. More patient, more resourced. Common against payment systems, identity providers, government.
- **Insider.** Someone with legitimate access who exceeds authorization. Hardest to defend; relies on access controls and audit logging.
- **Nation-state.** Top of the pyramid. Most teams will never face one; if you might, the threat model is qualitatively different and out of scope for most operator skills.

Model for the realistic attacker class. Defending against nation-states when your actual threat is opportunistic scanning wastes effort. Defending against opportunistic scanning when your actual threat is targeted is naive.

## Step 10: write up and review

A threat model is a document. It has:

- **System under threat-model.** Scope, data, users, assets.
- **DFD.** The diagram or its textual equivalent.
- **STRIDE table or list.** Per data flow, the threats that apply.
- **Abuser stories.** Per user story, the mirror attacker view.
- **Top threats by risk.** Likelihood and impact, ranked.
- **Mitigations.** Per threat, the controls planned, the controls accepted-as-residual.
- **Open questions.** Things that need more data before deciding.

The threat model is a living document; review at major changes. A threat model that's a year old and not refreshed against the current system is more dangerous than no threat model — it gives false confidence.

Review with adversarial eyes. Pull in someone who didn't write the model. They will spot assumptions the author didn't notice.

## Common anti-patterns

- **Treating threat modeling as a one-time exercise.** Updates with the system or it goes stale.
- **Stopping at STRIDE without abuser stories.** STRIDE is abstract; abuser stories surface threats STRIDE misses.
- **Stopping at abuser stories without STRIDE.** Abuser stories are biased by what the writer can imagine; STRIDE is exhaustive.
- **Modeling everything to the same depth.** Risk-tier the threats. Top risks get deep mitigation; low risks may be accepted explicitly.
- **No residual risk acknowledgment.** You won't mitigate everything. State what's accepted, why, and what the compensating controls are.
- **Threat model in a slide deck.** Slides don't survive the meeting. Write it as a doc.
- **Pattern-matching only to known incidents.** Patterns are durable; specific incidents are noise. Model from the data flow, not from the news.

## Output format

When this skill is invoked, produce:

1. **Scope** — system, data classes, user classes, assets.
2. **DFD** — entities, processes, data stores, flows, trust boundaries (table or indented list).
3. **STRIDE walk** — per flow, applicable threats with one-line description.
4. **Abuser stories** — top 5–10 against the most sensitive user stories.
5. **Attack tree** — for the top one to three highest-impact goals.
6. **Threats prioritized** — likelihood × impact, top 10.
7. **Mitigations** — per top threat, the prevent/detect/respond/recover controls planned.
8. **Residual risks** — what's accepted, with rationale.
9. **Open questions** — unknowns that need follow-up.

## Related skills

- `security-review` — diff-level review. Threat modeling is for design; security-review is for code.
- `architecture-decision-records` — capture the mitigation choices as durable decisions.
- `monitoring-and-alerting` — the detect bucket of mitigations lives here. Design alerts for the top threats.
- `incident-response` — the respond bucket has runbooks; pre-plan during threat modeling.
