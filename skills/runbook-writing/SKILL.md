---
name: runbook-writing
description: Use when authoring or editing a runbook that an oncall engineer will read at 3am with a page in hand and incomplete context. Triggers when the user mentions "write a runbook", "this alert needs a runbook", "what should the responder do", "playbook for this alert", "oncall doc", or "I keep getting paged for this and there's no doc". The skill covers the runbook structure that survives sleep deprivation, trigger conditions linked to alert rules, immediate actions ordered by reversibility, escalation tree, related-runbook crosslinks, and post-incident updates. For the alert that fires the page, see monitoring-and-alerting. For the incident response itself once mitigation has happened, see incident-response. For the post-mortem after, see post-mortem-writing.
metadata:
  version: 0.1.0
---

# Runbook writing

A runbook is read by a half-awake engineer with a pager buzzing and zero context loaded. Every sentence competes for that engineer's attention with the urge to fall back asleep. If the runbook reads like a design doc, it fails its purpose. If it reads like a decision tree the responder can execute in order, it works.

The discipline of runbook writing is to imagine the worst-case reader: someone who has never seen this system, has been paged twice already tonight, and has fifteen minutes before the blast radius doubles. The runbook is for that reader. Everyone else benefits from clarity too.

This skill covers the structural patterns that make runbooks usable under stress: trigger conditions that match the alert, immediate actions ordered by reversibility, an escalation tree that names humans not titles, and the maintenance loop that keeps runbooks honest. For the alert design that fires the page, see monitoring-and-alerting. For the incident playbook once mitigation has happened, see incident-response.

## When to invoke this skill

- Writing a runbook for a new alert that's about to be enabled.
- Editing an existing runbook that the oncall says didn't help during a real page.
- Reviewing a runbook PR before merge.
- Auditing a runbook library to flag the stale or unused ones.
- Onboarding a new responder and discovering that the runbook for their first page is unreadable.
- Post-incident: the post-mortem identified that the runbook gave bad advice or was missing.

## The structural shape

Every runbook has the same six sections, in the same order. The order is not stylistic; it's the order the responder reads in.

1. **Title and trigger.** What alert or symptom fires this runbook. One line.
2. **Immediate actions.** What to do in the first five minutes, in order, with reversibility called out.
3. **Diagnosis.** How to confirm the cause, what to look at, what commands to run.
4. **Mitigation.** The longer set of actions that stop user impact once the cause is known.
5. **Escalation.** Who to wake, in what order, and the criteria for waking each tier.
6. **Related runbooks.** Crosslinks to runbooks that handle adjacent or downstream symptoms.

Sections 2 and 5 are the ones the responder needs first. Sections 3 and 4 are reference. Section 6 is the lifeline when the runbook turns out to be the wrong one.

Anti-pattern: starting the runbook with "Background" or "Architecture overview". The responder doesn't need the architecture at 3am. They need step one.

## Trigger conditions

The runbook's trigger should match the alert rule, character for character. If the alert name is `payments_api_5xx_rate_above_1pct`, the runbook title is `payments_api_5xx_rate_above_1pct`, not "Payments API errors".

Why the exact match: the responder finds the runbook by searching for the alert name. A title that paraphrases the alert wastes search time. A title that aggregates multiple alerts into one runbook makes the responder unsure they're in the right place.

The trigger section should also list:

- **Alert query or source.** The exact metric, log, or trace condition that fires.
- **Threshold and window.** What value over what duration triggers the page.
- **Known false-positive conditions.** If the alert sometimes fires for benign reasons (deploy lag, expected batch job), call them out so the responder doesn't waste mitigation effort on a non-issue.

If an alert has more than one valid runbook (e.g., the same alert can mean two different root causes), the trigger section explicitly branches: "If you see X in the logs, follow this runbook; if you see Y, follow the other".

## Immediate actions

The first five minutes of an incident are when the most damage is done and the responder has the least information. The immediate-actions list is what they can do safely while still figuring out the situation.

Three rules for immediate actions:

- **Reversibility first.** Reversible actions go before irreversible ones. Restarting a service is reversible; failing over a database is harder to reverse; truncating a table is one-way. The responder should run the reversible steps without needing to think about consequences.
- **Bounded blast radius.** Each action should affect a known scope. "Disable the feature flag `payments-v2`" has a known blast radius. "Restart all backend pods" has a known blast radius. "Shut down the cluster" does not belong in immediate actions because the responder can't undo it cheaply.
- **One action at a time.** Each line is a single command or single click. If a step requires three commands, it's three lines, in order, with the expected output of each.

Anti-pattern: immediate actions that say "investigate the cause". Investigation is not an immediate action; it's the diagnosis section. Immediate actions are things the responder does, not things they think.

The output of immediate actions should be either (a) mitigation, in which case the incident is paused while the responder confirms, or (b) "didn't help, proceed to diagnosis".

## Diagnosis

The diagnosis section is the longer prose: how to confirm the actual cause once the immediate actions haven't already mitigated.

What belongs here:

- **Dashboards to check.** Direct links to the specific dashboard panels, not the dashboard homepage. The responder doesn't have time to navigate.
- **Log queries to run.** Pre-written queries (Splunk, Datadog, Loki, CloudWatch) that the responder can paste and run. Include the query, not a description of the query.
- **Common patterns and what they mean.** "If you see `connection reset by peer` in the upstream logs, it's usually the database failover; jump to mitigation step X." Patterns observed in past incidents are gold.
- **What it's not.** If there are common red herrings (a metric that looks alarming but isn't the cause), call them out. "The `disk_iops` metric will spike during this alert but it's a symptom, not the cause."

What doesn't belong here:

- General architecture diagrams. The responder is not learning the system tonight.
- Long historical context. "This alert was introduced in 2024 after the great database migration of..." adds no value.

## Mitigation

Mitigation actions are usually heavier than immediate actions: failover, scale-out, drain a node, revert a deploy. Each one needs:

- **Precondition.** What must be true before running this step (e.g., "only if the replica lag is under 5 seconds").
- **Command or runbook link.** The exact command or a link to the sub-runbook.
- **Expected outcome.** What the responder should see if the step worked.
- **Verification step.** How to confirm the mitigation actually mitigated, not just ran.

For irreversible or high-risk mitigations (database failover, traffic shift to backup region, data restore from backup), the runbook explicitly says "This step is one-way. Page the incident commander before running."

Anti-pattern: a mitigation step that says "see Slack thread #incident-2024-04 for how we did this last time". The Slack thread is ephemeral; the runbook is the durable artifact. Lift the relevant content into the runbook.

## Escalation tree

The escalation section names humans (or rotations), not abstract titles. "Page the database oncall" is fine if the responder can find the database oncall in PagerDuty in one click; otherwise specify the rotation name or schedule.

The tree has tiers:

- **Tier 1: primary oncall** — the responder reading the runbook now. They handle most pages.
- **Tier 2: secondary oncall** — paged when tier 1 has acknowledged but cannot mitigate within a defined window, or when they declare they need a second pair of eyes.
- **Tier 3: domain expert or manager** — paged for sev 1 incidents, or when tier 2 also cannot mitigate, or when the incident has crossed a duration threshold (e.g., 60 minutes unmitigated).

Each tier has explicit criteria for when to escalate to it. "Escalate to tier 2 if mitigation has not been confirmed within 20 minutes of the page" is a real criterion. "Escalate if it feels bad" is not.

Anti-pattern: an escalation tree that lists six tiers with no criteria. The responder doesn't know which tier matches their situation and either over-escalates (waking unnecessary people) or under-escalates (struggling alone past the point of usefulness).

## Related runbooks

Cross-references matter because the runbook the responder found might not be the right one. The related-runbooks section lists:

- **Upstream symptoms.** If this alert is often caused by an upstream issue, link the runbook for the upstream issue.
- **Downstream symptoms.** If this alert often causes a downstream alert to fire shortly after, link that runbook.
- **Adjacent runbooks.** Runbooks for similar-looking alerts that the responder might confuse with this one.

The cross-reference is two-way: if runbook A links to runbook B as a related downstream, runbook B should link back to A as an upstream.

## Post-incident updates

A runbook is alive. After every real page that used the runbook, the responder should update it with one of three notes:

- **Worked as written.** A timestamp and the page link. Confirms the runbook is current.
- **Worked with caveats.** What was off, what they had to figure out. This is the highest-value update.
- **Did not help / pointed wrong direction.** The runbook gave bad advice. Mark it stale and route to the runbook owner for a rewrite.

The post-mortem process for the incident should include a checkbox: "did the runbook need updates?" If yes, the update is a separate PR linked from the post-mortem.

Anti-pattern: a runbook that was written once during onboarding and never updated. After eighteen months of system drift, every step is wrong in some subtle way. The maintenance loop is what keeps the runbook from rotting.

## Format and length

The runbook is a single markdown file, ideally under 200 lines of body. If the runbook is longer than 200 lines, it's probably covering more than one alert and should be split.

Use:

- Numbered steps for sequences. Bullets for unordered options.
- Code blocks for any command or query that the responder will copy-paste.
- Bold for the words that matter when skimming (action verbs: "run", "check", "wait", "escalate").
- Links instead of inline content for anything that lives elsewhere (dashboard URLs, related runbooks, ticket templates).

Do not use:

- Long prose paragraphs. They don't survive being read at 3am.
- Embedded diagrams of architecture. The responder can read the architecture doc on a Tuesday.
- Jokes or filler. Cognitive load is the enemy.

## Common anti-patterns

- **Runbook that explains the system instead of telling the responder what to do.** Architecture goes in a separate doc; runbook is operational.
- **Runbook whose first step is "ping the team channel and wait".** The responder is paged because immediate action is needed; "wait for someone else" is not immediate action.
- **Steps without expected outcomes.** Responder runs a command, sees output, has no idea if it worked.
- **Escalation tier with no escalation criteria.** Responder either over-escalates or under-escalates because the runbook doesn't tell them when.
- **Stale runbook that nobody updates.** Linked from the alert, doesn't match the current system, actively misleads the responder.
- **Runbook that says "see Slack thread X".** Slack is ephemeral. Lift the content into the runbook.
- **Same runbook for multiple alerts with very different causes.** Split per alert, even if there's some duplication.
- **Runbook hidden in a wiki the responder can't find.** Link it from the alert payload directly.
- **No related-runbooks section.** When the responder is in the wrong runbook, they have no path to the right one.
- **No reversibility annotation on dangerous steps.** Responder runs `DROP TABLE` because the runbook said so.

## Output format

When this skill is invoked to write or review a runbook, structure the output as:

1. **Title** — exact match to the alert name.
2. **Trigger** — the alert query, threshold, window, known false positives.
3. **Immediate actions** — numbered, reversibility-annotated, one action per line.
4. **Diagnosis** — dashboards, log queries, known patterns, red herrings.
5. **Mitigation** — preconditions, commands, expected outcome, verification.
6. **Escalation** — tiers with criteria.
7. **Related runbooks** — upstream, downstream, adjacent.
8. **Maintenance note** — last-reviewed date, owner, link to most recent incident that used the runbook.

## Related skills

- `monitoring-and-alerting` — the alert that fires the runbook. If the alert is noisy or wrong, the runbook can't save it.
- `incident-response` — once the responder is in the runbook, the incident playbook takes over.
- `oncall-handoff-rituals` — the handoff between shifts depends on runbooks being current and findable.
- `post-mortem-writing` — the post-mortem captures whether the runbook helped and what to update.
- `oncall-rotation-design` — the rotation design assumes runbooks exist; without them, the rotation is unhealthy.
- `root-cause-analysis` — once mitigation is done, RCA may identify a runbook gap.
