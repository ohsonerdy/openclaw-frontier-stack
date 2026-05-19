---
name: local-dev-environment
description: Use when setting up, documenting, or fixing the local development environment that engineers use to run the codebase on their own machine. Triggers when the user mentions "set up dev environment", "works on my machine", "Docker setup", "devcontainer", "missing dependencies", "first-day setup", "onboarding doc", "broken install", or "what versions do I need". The goal is fresh-checkout to first PR in a defined number of minutes, not a 40-step README that drifts within a week. For the broader release/deploy workflow these dev environments feed into, see safe-public-release. For the dependency-version hygiene inside that environment, see dependency-upgrade-safely.
metadata:
  version: 0.1.0
---

# Local dev environment

The local dev environment is the slowest part of the onboarding curve and the most reliable source of "works on my machine" defects. It's also the lowest-status part of the codebase to maintain — every team has a setup README, almost no team treats it as production code, and almost every team pays for that neglect when the next engineer joins.

This skill is for designing, documenting, and maintaining the environment that an engineer uses on their laptop, in a devcontainer, or in a remote workspace. The deliverable is not "a working laptop"; it's a workflow where any new engineer's fresh checkout reaches their first PR inside a defined and measured time budget.

## When to invoke this skill

- Designing a new repo's dev workflow before the second engineer joins.
- Auditing an existing setup that's been drifting (the README hasn't been updated in months, new hires file the same three questions).
- Investigating a "works on my machine" bug — these are real bugs, not just inconveniences.
- After painful onboarding feedback ("it took me three days to get the app running locally").
- Migrating from "run it on your laptop" to containerized or devcontainer-based development.

The signal you need this skill: an engineer joins and spends more than a day fighting setup before writing their first line of code. Or a senior engineer says "ah yeah, that's broken for everyone, just do X to work around it." Both are smell, not normalcy.

## The parity-with-prod sliding scale

There is no single right answer for "how close should dev be to prod". There are levels, each with a tradeoff.

- **Level 1 — Language version pinned.** A `.tool-versions` (asdf), `.nvmrc` (node), `.python-version` (pyenv), or `rust-toolchain.toml` file. Everyone runs the same major.minor version of the language. Cheapest level; the floor below which "works on my machine" defects are unavoidable.
- **Level 2 — Services in containers, app on host.** The database, cache, message broker run in Docker on the host. The application code runs natively. This is the sweet spot for many web stacks: fast app iteration, clean service isolation.
- **Level 3 — Full stack via docker-compose.** Everything in containers, including the application. Slower iteration (rebuild on change unless mounted), but the dev environment matches prod's container shape.
- **Level 4 — Devcontainer / remote workspace.** The IDE attaches to a container or VM with the toolchain prebaked. Onboarding is "open the URL". Cost is the prebake time, the operator burden of maintaining the image, and a hard dependency on the host environment (VS Code Dev Containers, GitHub Codespaces, JetBrains Gateway).

Pick deliberately. Level 4 is the cheapest onboarding and the most expensive maintenance. Level 1 is cheap to maintain and expensive to onboard. Most teams should be at Level 2 by default and graduate to Level 4 only when the cost of onboarding exceeds the cost of devcontainer maintenance.

A common failure mode is mixing levels accidentally — services in containers but the app expects a different language version than what's documented. Pick a level and document it; don't drift between them.

## The "what's missing for someone joining today" audit

Open a private window. Pretend you are a new engineer with a fresh checkout and no institutional memory. Walk the README literally. Note every place where:

- A command silently fails because of a missing tool.
- A step assumes a specific version of a tool that the README doesn't pin.
- A secret or credential is required but the README points to "ask the team" rather than a documented retrieval path.
- A step depends on prior setup that the README hasn't told you to do.
- An error message would be cryptic to someone who hasn't seen the codebase before.
- A workaround that "everyone knows" but isn't written down.

The audit output is a list of issues, each with severity:

- **Blocking.** Cannot complete setup without team intervention. Fix today.
- **Major friction.** Setup is possible but takes hours. Fix this sprint.
- **Minor friction.** Cosmetic, surprising, or inconvenient. Fix when convenient.

Run this audit quarterly. Drift is inevitable; the audit is how you catch it before the next new hire suffers from it.

## The "fresh checkout to first PR in N minutes" benchmark

Pick a number. Document it. Measure against it. A reasonable target for a typical web codebase is 60 minutes; for a complex monolith with many services, 2-3 hours. For an obviously-simple library, 15 minutes.

The benchmark measures the time from `git clone` to the engineer being able to:

1. Run the test suite (or at least the unit tests).
2. Run the app locally and hit it from a browser or curl.
3. Make a trivial change and see it reflected.

If the number is much larger than your target, the dev environment is failing. If the number is unknown because nobody has measured, that's worse. Run the benchmark on a real new hire's first day with a stopwatch — not on a senior engineer who unconsciously skips broken steps.

## Secret bootstrap

The most common source of "works on my machine" is secrets — environment variables, API keys, database passwords, OAuth credentials. The rules:

- **Never check in real secrets.** Even ".env files in a private repo" is a leak waiting to happen. The repo history is forever; rotating leaked secrets is expensive.
- **Always ship `.env.example`.** A template that documents every required variable, with placeholder values and a one-line comment for what each is.
- **Document the retrieval path.** "Get the dev API key from 1Password, vault path `dev/api-key`" is precise. "Ask the team" is not. The retrieval path should be a click-or-copy operation, not a Slack message.
- **Validate at startup.** The app should fail loudly with a clear error message if a required environment variable is missing, naming the variable and pointing to the documentation.
- **Separate dev secrets from prod secrets.** Engineers should not have prod credentials on their laptops by default. If they need them, that's a specific authorization event, not the default.

A good test: after a `git clone`, the engineer copies `.env.example` to `.env`, fills in three values from their team's vault, and the app runs. If the engineer has to ask anyone anything during the bootstrap, the bootstrap is broken.

## Fast-feedback loop design

The dev environment is also a feedback-loop machine. Two specific optimizations:

- **Hot reload / live reload.** Changes to source code reflect in the running app within seconds, without a manual restart. Most modern frameworks support this; configure it on day one. The alternative — manual restart per change — is what drives engineers to write less code and test it less often.
- **Partial tests.** The engineer should be able to run one test, one file, one tag — not the full suite — in under 5 seconds. Test discovery overhead matters more than people admit. If `npm test` takes 90 seconds before any test runs, you'll watch engineers stop running tests.

For database state, the choice is between seeds and migrations:

- **Migrations only.** The dev DB is built by running every migration from zero. Pros: matches prod exactly. Cons: slow as the migration count grows; requires fresh DB to be useful.
- **Seeds + migrations.** A baseline data set is loaded after migrations run. Pros: realistic data for exercising the app. Cons: seed drift — the seed data ages, becomes wrong, becomes annoying.
- **Snapshot.** A periodic dump of (sanitized) production-shape data, restored locally. Pros: matches prod data shape. Cons: requires sanitization rigor; risks leaking PII into dev environments.

For most teams: migrations are the baseline, seeds are layered on top for realistic data, and snapshots are an option only when sanitization is genuinely safe.

## Kill the YAK rule

Every "works on my machine" is a real bug, not a quirk. The rule: when an engineer's machine produces different behavior from another engineer's machine, treat it as a defect with a real cost. The cost is: the engineer who hits the bug loses hours; the team that doesn't reproduce it ships code that has the bug latent; production is the next place the bug surfaces.

The triage when this happens:

1. **Reproduce on a third machine.** If a second engineer can reproduce, it's not the first engineer's machine — it's an environment defect.
2. **Identify the divergence.** Different OS, different language version, different dependency version, different env var. Use a diff of relevant config to localize.
3. **Pin the divergence.** Update the toolchain file, the lockfile, the `.env.example`, or the docker-compose to remove the gap.
4. **Add a check.** A startup-time assertion, a CI matrix entry, or a pre-commit hook that prevents the divergence from happening again.

The anti-pattern: "ah, that's just X's machine, don't worry about it." That is a deferred incident, not a closed bug.

## Reproducibility checklist

Before declaring the dev environment "good", verify:

- [ ] Language versions are pinned and enforced at startup or in CI.
- [ ] All services are containerized OR explicitly documented as host-installed with version pins.
- [ ] `.env.example` exists, is current, and a fresh checkout + fill-in-three-secrets + run actually works.
- [ ] The full setup README is dated, tested by a real new hire in the last quarter, and acknowledged when followed.
- [ ] A defined target time-to-first-PR exists and is measured against.
- [ ] Hot reload and partial tests work.
- [ ] CI runs against the same toolchain version that the README pins.
- [ ] Migrations are reversible (down migrations work); seeds are idempotent.
- [ ] No team-tribal knowledge is required during bootstrap.

A "no" on any of these is a backlog item, not a forever-state.

## Devcontainer specifics

If you've chosen Level 4 (devcontainer), the additional discipline:

- **Image build is cached and reproducible.** Building the devcontainer should not take 30 minutes every time; use base-image layering aggressively.
- **The image is versioned alongside the code.** When the dependencies change, the image rebuild is part of the PR, not a separate operation.
- **The container has the same shape as CI.** If CI runs `npm test` and the devcontainer's `npm test` fails for a different reason, you've split the environment in two.
- **Volume mounts are designed for performance.** On macOS especially, naive bind mounts can be 10x slower than the host for I/O-heavy work. Use named volumes for `node_modules`, the language cache, etc.
- **Fallback path documented.** If the devcontainer breaks, the engineer should be able to fall back to Level 1 or Level 2 setup. Don't lock the team into a single path that breaks the entire team when it breaks.

## Operating-system reality

Not every team can mandate "use macOS" or "use Linux". The practical posture:

- **Pick a primary platform.** Document which OS / architecture the dev environment is tested on. Everything else is best-effort.
- **Containers neutralize most OS gaps.** Level 2 and above sidesteps most "Windows vs macOS vs Linux" problems by running the services in Linux containers.
- **Native-tooling gaps are real.** PostgreSQL client libraries, Python C extensions, Rust toolchains all have OS-specific weirdness. Document the known landmines.
- **WSL2 on Windows is the unofficial Linux.** Most Windows engineers in modern web stacks run WSL2 and treat it as a Linux dev environment. Plan for it.

## Remote dev environments

Hosted workspaces (Codespaces, Gitpod, JetBrains Spaces, etc.) are a category of Level 4 with their own tradeoffs:

- **Onboarding is "open the URL".** The cheapest onboarding experience, when the host is healthy.
- **Costs are per-engineer-per-hour.** A team leaving workspaces running idle accumulates a real budget line. Set an idle-shutdown policy.
- **Network latency to the workspace host matters for IDE responsiveness.** Distributed teams may see different responsiveness depending on continent.
- **Stateful workspaces drift.** Engineers customize their workspace; after three weeks, two engineers are on subtly different setups. Periodic prebake-from-scratch is hygiene.
- **Fallback to local is essential.** A team locked into a single hosted provider has a continuity risk if the provider has an outage. Document the local-fallback path even if 99% of engineers use the remote.

The choice between local devcontainer (team maintains the image, engineers pull and run) and hosted workspace (vendor runs it) is partly build-vs-buy and partly team-distribution. Pick once; revisit annually.

## Configuration drift

A dev environment is not a static artifact. It drifts:

- **Tool versions move.** Node releases a new LTS; the team's `.nvmrc` is outdated.
- **Service versions move.** Postgres 14 to 15 in dev; prod is on 14; tests pass locally and fail in prod.
- **Documentation rots.** A new tool is added; the README isn't updated.
- **Workarounds calcify.** "We've been running with this env var for three months; nobody remembers why."

The cure is the quarterly audit plus a discipline of refreshing the dev environment when a major dependency moves, and not merging the refresh PR without testing via the new-hire flow. When production moves to a new major version of any dependency, the dev environment must move with it (or the documented gap must be explicit). Don't let prod and dev drift apart silently.

## When the dev environment is "done"

A dev environment is done when:

1. A new engineer can complete setup in less than the documented target time.
2. The setup README has been tested by a real new hire in the last quarter.
3. The toolchain is pinned and enforced (not just documented in prose).
4. Secrets bootstrap is documented and the retrieval path is one-click.
5. Hot reload and partial tests work for the daily-write-code workflow.
6. CI runs against the same toolchain version as local dev.
7. The audit list (above) has no blocking items.

"Done" is not "shipped once and forgotten". Drift is the default. Quarterly audit is the cure.

## Output format

When this skill is invoked to design or fix a dev environment, structure your output as:

1. **Current state assessment** — what level (1–4), what's pinned, what's not.
2. **Time-to-first-PR target** — proposed number; current actual (estimated if unmeasured).
3. **Top three frictions** — blocking items from the "what's missing" audit.
4. **Recommended level** — and the rationale.
5. **Secret bootstrap plan** — `.env.example`, retrieval path, validation at startup.
6. **Fast-feedback levers** — hot reload, partial tests, seeds vs migrations.
7. **Action list** — concrete tasks in priority order.

## Common anti-patterns

- **The 40-step setup README.** If setup is 40 steps, it's not really 40 steps — half of them are missing context that "everyone just knows". Containerize, automate, or accept the onboarding tax.
- **"It works on my machine" as a closed bug.** It's an open environment defect.
- **Secrets shipped in code.** Even private repos leak. Use `.env.example` and a documented vault path.
- **Documentation that hasn't been tested by a new hire.** The author has too much context to write accurate setup docs. Test on real first-day eyes.
- **Different versions in dev and CI.** The whole point of pinning is that CI matches local. Either pin everywhere or admit you're not really pinned.
- **No fallback path from Level 4.** Devcontainers and remote workspaces break. If the team can't fall back to Level 2, a single outage stops the whole team.
- **Optimizing for the senior engineer.** The senior engineer's muscle memory papers over broken setup. Onboarding is measured on first-day engineers.

## Related skills

- `safe-public-release` — the deploy/release workflow that the dev environment feeds into.
- `dependency-upgrade-safely` — the version-hygiene discipline inside this environment.
- `monitoring-and-alerting` — dev environment observability is its own subdomain; structured logging works the same way locally as in prod.
- `logging-discipline` — dev-side logging should match prod patterns so engineers see the same shape locally.
- `systematic-debugging` (obra/superpowers) — when "works on my machine" turns into a real environment-divergence bug.
