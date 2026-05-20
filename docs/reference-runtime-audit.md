# Reference Agent vs OpenClaw Frontier Stack — Research-Only Audit

> **Status:** Research artifact. Not a roadmap commitment.
> **Source repo:** `NousResearch/reference-runtime` @ default branch (cloned 2026-05-19, shallow).
> **Our repo:** `ohsonerdy/openclaw-frontier-stack` working tree at `ofs-now/`.
> **License of subject:** MIT (Copyright (c) 2025 Nous Research — see `reference-runtime/LICENSE`).
> **Audit format:** survey → inventory → gap table → reverse table → architecture → port plan → license/governance → honest assessment.

---

## 1. TL;DR

Reference Agent and the OpenClaw Frontier Stack (OFS) overlap on the
"agent framework with skills" surface but solve fundamentally different
problems. Reference Runtime is a **personal/team assistant runtime** — a Python
process that owns a conversation, talks to LLMs, ships a TUI, a CLI, and
a multi-platform messaging gateway (Telegram, Discord, Slack, WhatsApp,
Signal, Matrix, etc., 22 platforms total), with skills as a procedural-
memory library and Kanban-on-SQLite as the multi-agent coordination
primitive. OFS is a **multi-agent coding-orchestration substrate** —
Node.js modules for a signed bus, a durable blackboard ledger, a
TaskFlow FSM, a coordination-pattern library (fan-out / fan-in / chain /
voting), an 11-role contract roster, and release-gate machinery, all
designed to slot in alongside an existing agent host (Claude Code,
Codex, Cursor, OpenCode) rather than replace it.

By raw surface area Reference Runtime is ~10x our size: 89 built-in skills plus 81
optional skills (170 SKILL.md files vs our 51), ~14 tagged releases vs
our pre-1.0 cadence, ~1,168 test files, 22 messaging platforms, 7
terminal backends, dozens of provider adapters, a full Ink-based TUI, an
ACP server, an LSP integration, plug-in points for memory/context-engine/
model-providers/observability, and a cron scheduler with webhook
triggers. They have the **runtime stack**; we don't ship a runtime.

We have things they don't: a formally signed envelope/bus with Ed25519
detached signatures, a durable JSONL blackboard ledger as a coordination
primitive, an explicit FSM (taskflow) with task-claim/path-claim
semantics, four named coordination patterns codified as library
primitives (`fanOut` / `fanIn` / `chain` / `voting`), a separation-of-
powers agent contract layer with hard preconditions and forbidden paths,
a production-release-gate (`security-sentinel`) with quorum and
counter-signature, a public-surface harness + private-content scanner,
multi-host plugin manifests (Claude/Codex/Cursor/OpenCode in one tree),
and a release-notes/scribe lane. Reference Runtime covers some of these informally
(SQLite Kanban as durable claim, plugin hook system, approval gates)
but none with our level of formal cryptographic and FSM rigour.

Top recommended ports: their **cron + webhook trigger** model, their
**event-hook lifecycle surface** (gateway:startup, session:start,
agent:step…), their **`/handoff` mid-session session-transfer**
primitive, their **lazy-deps install tier** with supply-chain advisory
scanning, and their **delegate_tool subagent isolation** pattern with
ThreadPoolExecutor and per-child task-id. All informational — build
originals, do not copy code verbatim. License compatibility (MIT both
sides) means a clean-room rebuild is unblocked.

Net assessment: **Reference Runtime is ahead on runtime/UX/ecosystem.** OFS is
**ahead on coordination semantics and release governance.** They're not
the same product. The interesting move is to remain coordination-focused
and adopt their best ideas selectively — not chase parity on platforms
or skill count.

---

## 2. Reference Runtime Feature Inventory

### 2.1 Architecture

- **Process model:** single long-running Python process (`run_agent.py`,
  ~12k LOC `AIAgent` class). The agent loop is **synchronous**: a
  `while api_call_count < max_iterations` over OpenAI-format messages
  with tool calls dispatched in-process. No external bus, no event log
  by default — the conversation IS the coordination plane.
- **State store:** SQLite (`reference_state.py`, `SessionDB` class) with
  FTS5 enabled for full-text session search. Profile-aware paths via
  `get_reference_home()`.
- **Multi-agent coordination:** SQLite Kanban (`reference_cli/kanban.py`,
  `reference_cli/kanban_db.py`) with WAL mode, `BEGIN IMMEDIATE` write txns,
  and compare-and-swap (CAS) on `tasks.status`/`tasks.claim_lock`. One
  worker spawns per task via `kanban_swarm.py`. Schema:
  `tasks / task_links / task_comments / task_events`. Multiple boards
  supported (each a separate DB).
- **Subagent isolation:** `tools/delegate_tool.py` spawns child
  `AIAgent` instances with a separate `task_id`, restricted toolsets,
  blocked tools (`delegate_task`, `clarify`, `memory`, `send_message`,
  `execute_code`), and its own conversation history. Uses
  `ThreadPoolExecutor` with `initializer=_set_subagent_approval_cb` to
  avoid the prompt_toolkit-TUI vs subprocess-input() deadlock.
- **Plugin model:** Python plugins under `plugins/` discovered at
  import. Plugin types include `memory/`, `context_engine/`,
  `model-providers/`, `observability/`, `image_gen/`, `kanban/`,
  `platforms/`, `web/`, `disk-cleanup/`, etc. Plugins can register
  `tool_override` to replace built-in tools and can use `ctx.llm` for
  first-class LLM access (see `RELEASE_v0.14.0.md`).
- **Tool registry:** auto-discovery at import. Each file in `tools/`
  calls `registry.register()` at module load. `model_tools.py` ties
  registry → function-call dispatch.

### 2.2 Skills

- **Built-in skills (`skills/`):** 89 SKILL.md files across these
  categories — apple, autonomous-ai-agents, creative, data-science,
  devops, dogfood, domain, email, gaming, github, mcp, media, mlops,
  note-taking, productivity, red-teaming, research, smart-home,
  social-media, software-development.
- **Optional skills (`optional-skills/`):** 81 SKILL.md files across
  autonomous-ai-agents, blockchain, communication, creative, devops,
  dogfood, email, finance, health, mcp, migration, mlops, productivity,
  research, security, software-development, web-development.
- **Total skill surface:** ~170 SKILL.md files.
- **Skills Hub:** `agent/skills_hub.py` + `tools/skills_hub.py` — pulls
  community skills from `huggingface.co/skills` (default trusted tap as
  of v0.14.0). `agentskills.io` open-standard compatible.
- **Skill provenance/usage tracking:** `tools/skill_provenance.py`,
  `tools/skill_usage.py`.
- **Self-improvement loop:** README claims "agent creates skills from
  experience, improves them during use." Implementation via the
  `agent/skill_preprocessing.py` + `tools/skill_manager_tool.py`
  surfaces.
- **Slash-skill injection:** `agent/skill_commands.py` injects skill
  bodies as a **user message** (not system prompt) to preserve prompt
  caching.

### 2.3 Agent roles

Reference Runtime does **not** ship an explicit role taxonomy in the OFS sense.
The closest analogues:

- **Single primary agent** (`AIAgent`) per process, configured via
  personality/persona.
- **Delegate subagents** spawned ad-hoc via `delegate_tool` with a
  custom prompt and restricted toolset — these are role-shaped at
  dispatch time, not pre-declared.
- **Kanban workers** — `reference_cli/kanban_swarm.py` spawns one worker
  per task. Workers are isolated by board (`HERMES_KANBAN_BOARD` env).
- No `CONTRACT.md` files. No hard preconditions. No "what you must
  never do" rules baked into the role. No separation-of-powers between
  orchestrator/sentinel/architect/builder/reviewer.

### 2.4 Hooks / events / triggers

- **Gateway hook system** (`gateway/hooks.py`): event types include
  `gateway:startup`, `session:start`, `session:end`, `session:reset`,
  `agent:start`, `agent:step`, `agent:end`, `command:*` wildcard. Each
  hook lives under `<HOME>/.reference/hooks/<name>/` with `HOOK.yaml` metadata
  + `handler.py` async handler.
- **Shell-script hooks** (`agent/shell_hooks.py`): reads `hooks:` block
  from `cli-config.yaml`, prompts for consent on first use, routes
  through the same plugin hook manager. Pre-tool-call hooks can
  `block`/`approve` with `{"decision": "block", "reason": "…"}` shape
  (Claude-Code-compatible). Pre-llm-call hooks can inject context via
  `{"context": "Today is Friday"}`.
- **Cron scheduler** (`cron/scheduler.py`, `cron/jobs.py`): file-locked
  via `<HOME>/.reference/cron/.tick.lock` (fcntl on Unix, msvcrt on Windows),
  ticks every 60 s from a gateway background thread. Supports any cron
  expression + human intervals + `no_agent` mode (script-only,
  silent-by-convention).
- **Webhook subscriptions** (`reference webhook subscribe`): HMAC-auth'd
  inbound webhook routes that trigger agent runs with structured
  context. GitHub events (PR / issue / push) plus arbitrary JSON
  payloads. Delivery target per subscription (Slack, Telegram, etc.).
- **Routines parity:** `reference-already-has-routines.md` explicitly
  positions reference-cron+webhooks as already-shipping equivalents of
  Claude Code Routines (scheduled / GitHub / API triggers).

### 2.5 Coordination patterns

- **Fan-out via delegate_tool batch mode** — `tools/delegate_tool.py`
  supports parallel children via `ThreadPoolExecutor`. Parent blocks
  until all complete. Children's intermediate state is invisible to
  parent.
- **Mixture-of-agents** (`tools/mixture_of_agents_tool.py`) — layered
  multi-LLM coordination based on Wang et al. 2024 (arXiv:2406.04692).
  Reference models generate diverse responses in parallel, aggregator
  model synthesises. Models hardcoded to claude-opus-4.6 /
  gemini-3-pro-preview / gpt-5.4-pro / deepseek-v3.2 with
  claude-opus-4.6 as aggregator.
- **Kanban swarm** (`reference_cli/kanban_swarm.py`,
  `reference_cli/kanban_decompose.py`, `reference_cli/kanban_specify.py`) —
  decompose a goal into tasks, dispatch workers via Kanban, collect
  results. Compare-and-swap claim semantics, per-board isolation.
- **No formal voting/quorum primitive.** No fan-in joiner primitive.
  No chain pipeline (chains happen organically via the LLM loop).

### 2.6 Auth + key management

- **Provider OAuth:** `reference_cli/auth.py`, `auth_commands.py`,
  `copilot_auth.py`, `dingtalk_auth.py`, `vercel_auth.py`,
  `agent/google_oauth.py`, `agent/google_code_assist.py`,
  `agent/azure_identity_adapter.py`. Each provider gets its own
  bespoke OAuth flow (Anthropic, OpenAI, Google, Microsoft, xAI
  SuperGrok, Vercel, DingTalk, etc.).
- **Credential pool** (`agent/credential_pool.py`,
  `credential_sources.py`) — multiple keys per provider with rotation.
- **API-key allowlist for migration** (`reference claw migrate`) only
  imports specific allowlisted keys: Telegram, OpenRouter, OpenAI,
  Anthropic, ElevenLabs.
- **OAuth-proxy** (`reference proxy`): an OpenAI-compatible local proxy
  that wraps OAuth-authed providers (Claude Pro, ChatGPT Pro,
  SuperGrok) so any OpenAI-API tool can hit a paid subscription. New
  in v0.14.0.
- **DM pairing** (`gateway/pairing.py`) — pair a messaging platform
  bot to a user account.
- **Sudo brute-force block** + dangerous-command bypass closures
  (v0.14.0). Tool error sanitization before model context re-injection.

### 2.7 Storage / persistence

- **SQLite SessionDB** with FTS5 full-text search across all sessions.
- **WAL fallback** (`reference_state_wal_fallback.py` test) for read-only
  filesystems.
- **Atomic replace + symlinks safe** for session persistence.
- **No JSONL ledger / append-only audit log primitive.** Closest is the
  cron `.tick.lock` and the Kanban `task_events` table.
- **Honcho dialectic user modeling** (`plugins/memory/honcho`, optional
  skill `optional-skills/autonomous-ai-agents/honcho`) — dialectic
  conversation/user model that builds across sessions.
- **Memory providers** (`plugins/memory/`) — pluggable backends:
  honcho, mem0, supermemory, …
- **Context engine plugins** (`plugins/context_engine/`).

### 2.8 Tools / integrations

LLM providers and aggregators (non-exhaustive, from README + provider
adapters under `agent/`):
- Anthropic (native + OAuth + via OpenRouter + via Bedrock)
- OpenAI (chat-completions + codex-responses + cloudcode)
- Google (Gemini native + Gemini via Code Assist + cloudcode)
- xAI / Grok (SuperGrok OAuth)
- AWS Bedrock
- Azure
- Nous Portal
- OpenRouter (with Pareto Code router + `min_coding_score`)
- NovitaAI
- NVIDIA NIM / Nemotron
- Xiaomi MiMo
- z.ai / GLM
- Kimi / Moonshot
- MiniMax
- Hugging Face
- LM Studio (`agent/lmstudio_reasoning.py`)
- LiteLLM-style custom endpoints

Tool surface (`tools/`):
- Terminal (`terminal_tool.py`) with 7 backends: local, Docker, SSH,
  Modal, Daytona, Singularity, Vercel Sandbox (`tools/environments/`).
- Browser (`browser_tool.py`, `browser_cdp_tool.py`, `browser_camofox.py`)
  with 180x faster CDP path (v0.14.0).
- Computer-use (`computer_use_tool.py`, `tools/computer_use/`) with
  cua-driver backend for non-Anthropic providers.
- Code execution, file ops, file safety, file state tracking.
- Image generation (`image_generation_tool.py`,
  `agent/image_gen_provider.py`, pluggable).
- Video generation (`video_generation_tool.py`,
  `agent/video_gen_provider.py`, pluggable).
- TTS (`tts_tool.py`, `tools/neutts_synth.py`), transcription
  (`transcription_tools.py`), vision analyze (`vision_tools.py`).
- Web search (`web_tools.py`, `agent/web_search_provider.py`) — Tavily,
  Exa, SearXNG, Brave Search, DuckDuckGo.
- Skill manager, skill provenance, skill usage, skills hub.
- MCP (`mcp_tool.py`, `mcp_oauth.py`, `mcp_oauth_manager.py`,
  `mcp_serve.py`) — full MCP client + server.
- Memory (`memory_tool.py`, `agent/memory_manager.py`,
  `agent/memory_provider.py`).
- Session search (`session_search_tool.py`).
- Delegate (subagent), todo, clarify, send_message, interrupt,
  checkpoint manager.
- X / Twitter search (`x_search_tool.py`, `xai_http.py`).
- Discord, Feishu doc/drive, Homeassistant, Yuanbao.
- Microsoft Graph (`microsoft_graph_auth.py`,
  `microsoft_graph_client.py`).
- Cron-job tools (`cronjob_tools.py`), kanban tools (`kanban_tools.py`).

### 2.9 Tests + verification gates

- **~1,168 Python test files** under `tests/` (across run_agent, agent,
  cli, gateway, tools, plugins, providers, acp, cron, fakes, e2e,
  integration, stress, honcho_plugin, openviking_plugin, …).
- **`scripts/run_tests.sh`** is the canonical entrypoint.
- **Doctor command** (`reference doctor` → `reference_cli/doctor.py`) — health
  checks at runtime.
- **LSP diagnostics on every write** (`agent/lsp/`) — runs a real
  language server against edited files, surfaces type errors before
  next turn. New in v0.14.0.
- **Per-turn file-mutation verifier footer** — after every write, agent
  gets a footer summarising on-disk delta. New in v0.14.0.
- **Adversarial UX tests** (`optional-skills/dogfood/adversarial-ux-test/`)
  — self-skill that runs the agent against itself.
- **Supply-chain advisory checker** scans installs for unsafe versions
  (v0.14.0, response to "Mini Shai-Hulud" worm).
- **Contributor audit script** (`scripts/contributor_audit.py`).
- **Lint-diff script** (`scripts/lint_diff.py`).

### 2.10 CLI surface

`reference_cli/` is 86 files including:
- `main.py`, `commands.py` — central `COMMAND_REGISTRY` of `CommandDef`
  objects that drives CLI, gateway, Telegram menu, Slack subcommand
  map, autocomplete, and help. One registry, many consumers.
- `cron.py`, `goals.py`, `kanban.py`, `kanban_decompose.py`,
  `kanban_specify.py`, `kanban_swarm.py`, `kanban_diagnostics.py`
- `webhook.py` — webhook subscription manager.
- `gateway.py`, `gateway_windows.py` — gateway launcher.
- `auth.py`, `auth_commands.py`, `copilot_auth.py`, `dingtalk_auth.py`,
  `vercel_auth.py`
- `doctor.py`, `dep_ensure.py`, `security_advisories.py`
- `inventory.py`, `bundles.py`, `tips.py`, `banner.py`, `colors.py`
- `mcp_config.py`, `memory_setup.py`, `model_catalog.py`,
  `model_normalize.py`, `model_switch.py`
- `pty_bridge.py`, `web_server.py` — dashboard + chat-pane bridge.
- `voice.py`, `slack_cli.py`
- `skin_engine.py`, `skills_config.py`, `skills_hub.py`
- `claw.py` — OpenClaw migration command.

Slash commands (in CLI and gateway): `/new`, `/reset`, `/model`,
`/personality`, `/retry`, `/undo`, `/compress`, `/usage`, `/insights`,
`/skills`, `/stop`, `/handoff` (live session transfer — new in v0.14.0),
`/subgoal` (append criteria to active goal — new in v0.14.0), `/goal`
(persistent Ralph-loop goal with judge), `/platforms`, `/status`,
`/sethome`, `/copy`, `/paste`, `/resume`, `/help`, `/quit`, `/clear`,
plus `/<skill-name>` for any installed skill.

### 2.11 TUI

- `ui-tui/` — Ink (React) TUI in TypeScript with packages: `reference-ink`,
  `ink`, `app/`, `components/`, `hooks/`, `lib/`.
- `tui_gateway/` — Python JSON-RPC backend over newline-delimited stdio.
- Entries: `entry.py`, `server.py`, `slash_worker.py`, `transport.py`,
  `ws.py`.
- Real platform-native button UI for `clarify` on Telegram + Discord
  (v0.14.0).
- OSC8 hyperlinks for clickable URLs in any modern terminal.
- KawaiiSpinner with skin engine (`reference_cli/skin_engine.py`) —
  data-driven CLI theming.

### 2.12 Messaging gateway

`gateway/platforms/` ships 22 platform adapters:
- `bluebubbles.py`, `dingtalk.py`, `discord.py`, `email.py`, `feishu.py`,
  `homeassistant.py`, `matrix.py`, `mattermost.py`, `msgraph_webhook.py`
  (Microsoft Teams), `qqbot/`, `signal.py`, `slack.py`, `sms.py`,
  `telegram.py`, `webhook.py`, `wecom.py`, `weixin.py`, `whatsapp.py`,
  `yuanbao.py`, `api_server.py`.
- Plus `plugins/platforms/`: `google_chat/`, `irc/`, `line/`, `simplex/`,
  `teams/`.
- `gateway/run.py`, `gateway/session.py`, `gateway/session_context.py`,
  `gateway/delivery.py`, `gateway/mirror.py`, `gateway/pairing.py`,
  `gateway/platform_registry.py`, `gateway/stream_consumer.py`.
- `gateway/builtin_hooks/` — extension point, currently empty.

### 2.13 ACP (Agent Client Protocol)

- `acp_adapter/` — full ACP server for VS Code / Zed / JetBrains
  integration (`auth.py`, `edit_approval.py`, `entry.py`, `events.py`,
  `permissions.py`, `server.py`, `session.py`, `tools.py`).
- `acp_registry/` — `agent.json` + `icon.svg` for the Zed ACP Registry.
- Installable via `uvx` (one-click in Zed).

### 2.14 Web dashboard

- `web/` — Vite + TypeScript dashboard.
- `reference_cli/web_server.py` exposes `/chat` with `@app.websocket("/api/pty")`
  embedding the real `reference --tui` over a POSIX PTY bridge (WSL2 only
  for now).

### 2.15 Documentation philosophy

- **Documentation site:** `https://reference-runtime.nousresearch.com/docs/`
  (Docusaurus, source under `website/`).
- **`README.md` is the marketing front door** — feature pitch + install
  one-liner + 5 most-used commands.
- **`AGENTS.md` is the developer guide** — project structure,
  AIAgent class, CLI architecture, TUI architecture, slash command
  registry, plugin model.
- **Release notes** live as `RELEASE_v0.2.0.md` … `RELEASE_v0.14.0.md`
  in repo root.
- **Per-platform adapter contract** documented in
  `gateway/platforms/ADDING_A_PLATFORM.md`.
- **Provider plugin README** at `providers/README.md`.
- **`reference-already-has-routines.md`** — explicit competitive positioning
  vs Claude Code Routines.

### 2.16 Distribution

- **PyPI package** (`pip install reference-runtime`) — new in v0.14.0.
- **One-liner shell installers:** `scripts/install.sh`, `install.ps1`,
  `install.cmd`. Bundled MinGit on Windows. Termux install path.
- **`setup-reference.sh`** for contributors — `uv venv`, `.[all,dev]`,
  symlink `<HOME>/.local/bin/reference`.
- **Dockerfile** + `docker-compose.yml` + `docker/` directory.
- **Nix flake** (`flake.nix`, `flake.lock`, `nix/`).
- **`pyproject.toml`** with exact-pinned dependencies (no ranges, supply-
  chain rationale documented inline).
- **Lazy-deps tier** (`tools/lazy_deps.py`) — heavyweight backends
  (Slack/Matrix/Feishu adapters, image-gen SDKs, voice/TTS providers)
  install on first use rather than at install.
- **Tiered install** falls back when a wheel doesn't fit the platform.
- **Termux extra** (`.[termux]`) excludes Android-incompatible voice
  deps.

### 2.17 License + governance

- **MIT** (`LICENSE` — Copyright (c) 2025 Nous Research).
- **`CONTRIBUTING.md`** present.
- **`SECURITY.md`** present.
- **Discord community + Skills Hub at agentskills.io**.
- **No formal RFC process visible**, no separation-of-powers contract
  layer.
- **Release manager** is `scripts/release.py`.

### 2.18 Repo activity

- **Stars:** 157,585 (as of clone date, per GitHub API).
- **Forks:** 25,432.
- **Watchers:** 157,585.
- **Subscribers:** 602.
- **Open issues:** 12,107.
- **Commits since last tag (v0.14.0 release):** 808 commits, 633 merged
  PRs, 1,393 files changed, 165,061 insertions in the 0.13.0 → 0.14.0
  window.
- **Contributors:** 215 community contributors in the v0.13.0 → v0.14.0
  window alone.
- **Created:** 2025-07-22. **Last push:** 2026-05-19.
- **Has issues / projects / wiki / pages / pull-requests:** all enabled.
- **Default branch:** `main`. Pull-request creation policy: `all`.
- **Topics include:** `openclaw`, `clawdbot` — explicit positioning
  as the OpenClaw successor.

### 2.19 Things unique to them I didn't expect

- **`reference claw migrate`** — first-class import of an `<HOME>/.openclaw`
  install (SOUL.md persona, MEMORY/USER, skills → `<HOME>/.reference/skills/
  openclaw-imports/`, allowlisted secrets, messaging settings).
  Documented as the migration path from OpenClaw to Reference Runtime.
- **Voice memo transcription** end-to-end on messaging platforms.
- **Pokemon player** + **Minecraft modpack server** as gaming skills.
- **OpenHue** for Philips Hue smart-home control.
- **Honcho dialectic user model** — third-party plugin
  (`plastic-labs/honcho`) wired in for cross-session user modeling.
- **Trajectory compressor** (`trajectory_compressor.py`) for training
  next-gen tool-calling models from the conversation log.
- **Batch trajectory generation** (`batch_runner.py`).
- **Skin engine** for the CLI — data-driven theming with banner colors,
  spinner faces/verbs/wings, tool prefix, response box.
- **Adversarial UX test** as a meta-skill (the agent stress-tests
  itself).
- **Strike-freedom-cockpit** plugin (no public doc — internal codename).
- **PTY bridge** for embedding the real TUI inside a browser dashboard
  WebSocket.
- **Channel-directory** + **whatsapp-identity** + **mirror** as gateway
  components.
- **Plugins can call `ctx.llm`** — first-class plugin LLM access through
  the active provider/credentials (v0.14.0).
- **Pareto Code router with `min_coding_score`** — pick cheapest model
  that meets a coding-quality bar.
- **`/subgoal`** — append success criteria to an active `/goal`
  Ralph-loop without restart.

---

## 3. Our Feature Inventory (Cross-Reference)

`ofs-now/` at audit time:

### 3.1 Skills (51)

Under `skills/`, three logical categories (per CLAUDE.md framing):
- **Marketing (28):** ab-testing, ad-creative, ads, ai-seo,
  bundle-pricing, cart-abandonment-recovery, cohort-retention,
  content-strategy, copywriting, cro, cross-sell-mapping,
  customer-research, dunning-deep-dive, email-marketing,
  nps-and-detractor-handling, paid-ltv-optimization,
  pricing-discipline, product-marketing-positioning, programmatic-seo,
  referral-program-design, repeat-purchase, schema-markup, seo-audit,
  social-strategy, subscription-churn, subscription-growth,
  winback-flows, launch.
- **Engineering (20):** api-deprecation, api-design,
  architecture-decision-records, backup-and-restore,
  code-review-giving, dependency-upgrade-safely, feature-flagging,
  incident-response, load-testing, local-dev-environment,
  logging-discipline, monitoring-and-alerting, oncall-rotation-design,
  performance-profiling, post-mortem-writing, refactoring-safety,
  root-cause-analysis, schema-design, security-review,
  threat-modeling.
- **Operator (3):** durable-task-ledger, safe-public-release,
  verified-history-scan.

### 3.2 Agent roster (11 roles)

Under `agents/`:
- `orchestrator/` — decomposes goals, dispatches lanes, collects
  receipts, synthesizes. Cannot ship public.
- `security-sentinel/` — public-release gate, issues `PROPOSE_RELEASE`.
  Operator counter-signs.
- `architect/` — owns release-gate code, workflows, plugin manifests,
  harness shape.
- `builder/` — writes feature code under non-gated paths. Bot identity
  required for any commit.
- `reviewer/` — gates PRs. Cannot approve own PRs.
- `researcher/` — surfaces facts, never code.
- `marketing-strategist/` — drives Modern Skills roadmap. Briefs only.
- `executive-summary/` — operator-facing rollups. Summarises, never
  decides.
- `scribe/` — owns CHANGELOG.md and release-notes prose.
- `dependency-warden/` — one dep at a time. Escalates majors.
- `eval-runner/` — triggers and triages scheduled-evals workflow runs.

Each role has a `CONTRACT.md` with Mission / Hard preconditions /
Decision authority / What you must NEVER do / Output shape.

### 3.3 Coordination patterns (4)

Under `lib/coordination/`:
- `fan-out.js` — dispatch N parallel tasks, wait all.
- `fan-in.js` — wait for N upstream, dispatch joiner.
- `chain.js` — sequential N-step pipeline, each step sees prior output.
- `voting.js` — cross-role decision with quorum + threshold.

`index.js` exports `PATTERNS` frozen object plus individual functions.
Pure JS, no runtime deps beyond blackboard ledger and taskflow runtime.

### 3.4 Autonomous loops (5)

Under `.github/workflows/`:
- `autonomous-loops.yml`
- `dependency-vulnerability-scan.yml`
- `documentation-staleness.yml`
- `performance-baseline-drift.yml`
- `prompt-tuning.yml`
- `scheduled-evals.yml`
- `release.yml`
- `verify-package.yml`

(That's 8 files total; 5 are the "autonomous loops" set, the other 3
are release/verify gating.)

### 3.5 CLI surface

- `bin/openclaw` — engineer CLI. Subcommands: `goal`, `status`,
  `dispatch`, `recap`, `watch`. Flags include `--blackboard`,
  `--mock-agents`, `--dry-run`, `--max-wait-ms`, `--pattern`, `--json`,
  `--days`, `--trace-dir`.
- `bin/openclaw-agent` — live single-role agent runner daemon. One
  process per role. Reads `agents/<role>/CONTRACT.md`, polls blackboard
  for matching `task-claim` records, runs hard-rule checks on model
  output, writes `result`/`decision` records, logs audit ndjson.

### 3.6 Core primitives

Under `src/` (also exposed as `crates/`):
- `signed-bus/` — Ed25519 signed envelope library. Detached signatures
  over canonical JSON. Pure-JS implementation.
- `blackboard/` — durable JSONL ledger with task-claim, path-claim,
  path-release, fact, decision, result record kinds. Append-only.
- `taskflow/` — FSM library with states `queued / claimed / waiting /
  done / failed / blocked`.
- `orchestrator/` — goal-loop runner + mock-agent harness.
- `remote-approval/` — read-only approval requests + state snapshots +
  diff/test receipts + reviewer decisions.
- `skill-forge/` — skill registry with `demo-skills/`.
- `memory-adapters/` — RAG / vector memory / CAG / compaction adapters.
- `integration-adapters/` — Modern AI MCP integration model.

### 3.7 Plugin manifests (4 hosts)

- `.claude-plugin/` — Claude Code plugin manifest.
- `.codex-plugin/` — Codex CLI plugin manifest.
- `.cursor-plugin/` — Cursor skills manifest.
- `.opencode/` — OpenCode plugin manifest.

Same `skills/` + `hooks/` surface declared per host.

### 3.8 Hooks

`hooks/hooks.json`:
- `Stop` → `private-content-scan.js` — scan working tree on turn end.
- `PreToolUse` matcher `Bash` + `git push` → `git-push-gate.js` — block
  git push to public remotes if private content found.

Plus `.githooks/` for repo-level commit hygiene.

### 3.9 Release gate

`release-gate/`:
- `artifacts/`, `exports/`, `lib/`, `release-notes/`, `reports/`,
  `tests/`, `scripts/`, `checklist.md`,
  `reviewer-decision-schema.md`, `reviewer-decision.template.yaml`.
- Production-release-gate machinery: target-bound approval, readback,
  manifest generation.

### 3.10 Eval runner

- `scripts/run-skill-evals.js` — multi-model eval runner with backends
  for Anthropic (native), OpenAI-compatible (Ollama, vLLM, OpenAI).
- `scripts/eval-blackboard-contention.js`,
  `eval-frontier-orchestration-scale.js`,
  `eval-security-governance.js`,
  `eval-self-healing-recovery.js`.

### 3.11 Verifier surface

- `npm run verify` — local package verifier.
- `npm run verify:public-surface` — public-surface harness.
- `npm run verify:github-readback` — GitHub API readback.
- `npm run verify:history` — git history scan.
- Private content scan (hooks-driven on `Stop`) — blocks publication of
  internal emails, tilde-home paths, internal IPs, Bearer tokens.

### 3.12 Documentation (38 docs)

`docs/` covers: agent-daemon, agent-roster-manifest, agent-system,
architecture-diagrams, artifact-catalog, bus-and-blackboard-protocol,
bus-connectivity-diagnostics, communication-planes,
delegation-router-policy, end-to-end-trace, fleet-orchestration,
fleet-parity-and-soul-baseline, fresh-clone-verification,
github-repository-hygiene, goal-system, graph-system, maintainer-
handoff, memory-rag-cag-compaction, mission-control-control-plane,
orchestration, package-edit-claims, production-release-gates,
public-release-boundaries, release-scope, remote-approval-state-parity,
repository-initialization-checklist, runtime-ops, sentinel-release-gate,
skill-eval-telemetry, skill-forge, skills-integration-spec, security/,
security-governance, supply-chain-security, taskflow-result-contracts,
verification-flow, WIKI_INDEX, evaluations/.

### 3.13 Examples

`examples/`: demo-swarm, goal-loop-demo, memory-demo,
mission-control-demo, remote-approval-demo.

---

## 4. Gap Table — What Reference Runtime Has, We Don't

> **"Should we port"** answers: YES (worth doing), NO (out of scope),
> ADAPT (port the idea, not the implementation), DEFER (later release).
> **Priority:** HIGH / MEDIUM / LOW.

| # | Reference Runtime feature | Description | Our equivalent? | Should we port? | Priority |
|---|---|---|---|---|---|
| 1 | Cron scheduler with delivery targets | `reference cron create "0 2 * * *" "<prompt>" --deliver telegram` — built-in cron with file-locked tick from gateway background thread, supports any cron expression + human-readable intervals + `no_agent` script-only mode. `cron/scheduler.py`, `cron/jobs.py`. | Partial — `.github/workflows/scheduled-evals.yml` schedules eval runs, but no operator-facing "schedule a prompt → deliver to channel X" surface. | ADAPT — design our own around blackboard task-claim records emitted by a tiny cron daemon. | HIGH |
| 2 | Webhook subscription system | `reference webhook subscribe` registers HMAC-auth'd inbound routes that trigger agent runs with structured context. Supports GitHub events + arbitrary JSON. `reference_cli/webhook.py`. | None. | ADAPT — add `openclaw webhook subscribe` that drops a TASK envelope on the blackboard with the payload. | HIGH |
| 3 | Gateway hook lifecycle | Event types: `gateway:startup`, `session:start`, `session:end`, `session:reset`, `agent:start`, `agent:step`, `agent:end`, `command:*` wildcard. Hooks live in `<HOME>/.reference/hooks/<name>/{HOOK.yaml,handler.py}`. `gateway/hooks.py`. | Two-event hook (`Stop`, `PreToolUse`) on host-specific paths only. | YES — extend `hooks/hooks.json` to a lifecycle schema with named events, keep host-neutral. | HIGH |
| 4 | Shell-script hook contract | Hooks read JSON from stdin (`{hook_event_name, tool_name, tool_input, session_id, cwd, extra}`), write JSON to stdout (`{decision:block, reason:…}` or `{context:…}`). Consent-gated allowlist at `<HOME>/.reference/shell-hooks-allowlist.json`. `agent/shell_hooks.py`. | Our `private-content-scan.js` runs as a Node script with no stdin/stdout contract. | YES — formalise the contract so any executable can be a hook. | HIGH |
| 5 | `/handoff` live session transfer | Move an active session — every message, every tool call, every piece of context — to a target model/persona/profile mid-run without dropping anything. v0.14.0. | None — no session concept at this level. | DEFER — depends on us shipping a runtime first. | LOW |
| 6 | `/goal` Ralph-loop with judge | Persistent goal where the agent keeps going until success criteria are met. `/subgoal` appends criteria mid-run. | We have `openclaw goal` but it's one-shot (synthesizes once, exits). No persistent loop, no judge. | YES — add a `--persistent` mode to `openclaw goal` that loops until the goal-loop synthesiser declares done. | MEDIUM |
| 7 | Delegate-tool subagent isolation | Spawns child `AIAgent` instances with: isolated context, separate `task_id`, restricted toolsets, blocked tools (no recursive delegate / clarify / memory / send_message / execute_code), parent blocks until all complete. ThreadPoolExecutor with init-callback to avoid TUI/subprocess deadlock. `tools/delegate_tool.py`. | We have role-isolation via `openclaw-agent --role …` per process, but no in-process subagent fan-out. | ADAPT — add a `subagent.js` helper inside `lib/coordination/` that spawns N child orchestrator runs with restricted toolsets and writes their results back as fan-in records. | MEDIUM |
| 8 | Mixture-of-Agents tool | Layered multi-LLM coordination per Wang et al. 2024. Reference models generate parallel responses; aggregator synthesises. `tools/mixture_of_agents_tool.py`. | Voting pattern is close but voting picks one winner, MoA synthesises N→1. | ADAPT — add `synthesize.js` as a fifth coordination pattern. | MEDIUM |
| 9 | LSP semantic diagnostics on every write | After `write_file`/`patch`, runs a real language server against the edited file, surfaces type errors before next turn. `agent/lsp/` directory. | None. | DEFER — requires a runtime to integrate with. | LOW |
| 10 | Per-turn file-mutation verifier footer | After every write/edit turn, agent gets a short footer summarising on-disk delta. Catches silent overwrites. | None. | DEFER — requires a runtime. | LOW |
| 11 | OpenAI-compatible local OAuth proxy | `reference proxy` exposes `http://localhost:port` that speaks OpenAI API backed by Claude Pro / ChatGPT Pro / SuperGrok OAuth subscriptions. | None. | NO — outside our scope, we don't own auth. | LOW |
| 12 | Lazy-deps install tier | Heavyweight backends (Slack/Matrix/Feishu/image-gen/voice/TTS) install on first use rather than at install. Tiered fallback when wheels don't fit. Exact-pinned core deps with supply-chain rationale. `tools/lazy_deps.py`. | We pin Node deps with `package-lock.json` but no lazy-install tier. | YES — adopt the "core deps exact-pinned + optional deps lazy" pattern for our future Python subskills + future Modern AI MCP adapters. | MEDIUM |
| 13 | Supply-chain advisory checker | Scans every install for unsafe versions (post Mini Shai-Hulud incident). `reference_cli/security_advisories.py`. | Partial — `npm run verify` runs but no explicit supply-chain check. | YES — add `npm run verify:supply-chain` using `npm audit --json` + OSV. | HIGH |
| 14 | Doctor command | `reference doctor` runtime health check across config, providers, paths, processes. `reference_cli/doctor.py`. | None — our `verify` is build-time, not runtime. | YES — add `openclaw doctor` that checks blackboard reachability, signed-bus keys, role-contract presence. | HIGH |
| 15 | Trajectory compressor | Compresses full conversation logs for training the next generation of tool-calling models. `trajectory_compressor.py`. | None. | NO — we're not training models. | LOW |
| 16 | Batch trajectory generation | `batch_runner.py` runs N tasks in parallel with checkpointing. | Our `openclaw goal --pattern fan-out` is the spiritual equivalent but lacks checkpointing. | ADAPT — add checkpoints to the goal loop so a long run can resume. | MEDIUM |
| 17 | Session search with FTS5 | Full-text search across all past sessions. `agent/session_search_tool.py` + `reference_state.py`. | None — no session persistence yet. | DEFER — requires runtime. | LOW |
| 18 | 22 messaging platform adapters | Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, MS Teams, Email, SMS, DingTalk, WeCom, Weixin, Feishu, QQBot, BlueBubbles, Yuanbao, IRC, LINE, SimpleX, Google Chat, Webhook. | None. | NO — out of scope. | LOW |
| 19 | 7 terminal backends | local, Docker, SSH, Modal, Daytona, Singularity, Vercel Sandbox. `tools/environments/`. | None — we run wherever the host runs. | NO — runtime concern. | LOW |
| 20 | Computer-use cua-driver | Mouse/keyboard control of GUI apps, works with non-Anthropic models. `tools/computer_use/`. | None. | NO. | LOW |
| 21 | Ink-based TUI | Full React-in-the-terminal experience via Ink + JSON-RPC stdio. `ui-tui/`, `tui_gateway/`. | None — we ship CLI text only. | DEFER — only if we ship a runtime. | LOW |
| 22 | Web dashboard with PTY embedding | `reference dashboard` serves a Vite + TS web UI that embeds the real TUI over a POSIX PTY WebSocket. `web/`, `reference_cli/web_server.py`. | None. | DEFER. | LOW |
| 23 | ACP server | VS Code / Zed / JetBrains integration via Agent Client Protocol. `acp_adapter/`, `acp_registry/`. Installable via `uvx`. | We integrate with host IDEs via plugin manifests, not ACP. | DEFER — explore once IDE-side ACP support matures. | LOW |
| 24 | Skill provenance + usage tracking | `tools/skill_provenance.py`, `tools/skill_usage.py` — log which skill was invoked when and where it came from. | None. | YES — record skill invocations as facts on the blackboard. | MEDIUM |
| 25 | Skills Hub with HuggingFace trusted tap | Default tap pulls from `huggingface.co/skills`. `agent/skills_hub.py`. | None — skills are bundled in-repo. | ADAPT — define a Skill Forge external-tap spec; allow operator to add trusted taps. | MEDIUM |
| 26 | Skill manager tool | Agent-facing tool to install, update, list skills. `tools/skill_manager_tool.py`. | None — operator manages skills out-of-band. | DEFER — requires runtime. | LOW |
| 27 | Skin engine | Data-driven CLI theming: banner colors, spinner faces/verbs/wings, tool prefix, response box. `reference_cli/skin_engine.py`. | None — single style. | NO — cosmetic, low operator value. | LOW |
| 28 | Honcho dialectic user modeling | Cross-session user model built from conversation. `plugins/memory/honcho`. | Our memory-adapters cover RAG/CAG/compaction but no dialectic user model. | DEFER — runtime-shaped. | LOW |
| 29 | Slash command central registry | One `COMMAND_REGISTRY` of `CommandDef` objects drives CLI, gateway, Telegram menu, Slack subcommand map, autocomplete, help. `reference_cli/commands.py`. | Our CLI has hard-coded subcommands in `bin/openclaw`. | ADAPT — refactor `bin/openclaw` to read a central `commands.json` once we have a second consumer (e.g. a web view or a slash-command bridge). | MEDIUM |
| 30 | DM pairing | Pair a messaging bot to a user account. `gateway/pairing.py`. | None. | NO. | LOW |
| 31 | Sudo brute-force block | Approval gate blocks `sudo -S` brute-force, classifies stdin-fed sudo as DANGEROUS. v0.14.0. | None — we don't own command execution. | NO. | LOW |
| 32 | Tool-error redaction | Tool error strings are filtered before re-injection into model context — blocks prompt injection via error output. | None. | DEFER — runtime concern. | LOW |
| 33 | Plugin `ctx.llm` access | Plugin authors can make LLM calls through the active provider/credentials. `tool_override` flag swaps a built-in tool. v0.14.0. | None — we don't host plugins, we ARE plugins of other hosts. | NO. | LOW |
| 34 | Pareto Code router | OpenRouter "Pareto" router with `min_coding_score` knob — cheapest model that meets a coding-quality bar. | None. | DEFER. | LOW |
| 35 | Voice memo transcription | End-to-end voice → text → agent → text → voice on messaging platforms. `tools/transcription_tools.py`, `tools/tts_tool.py`. | None. | NO. | LOW |
| 36 | Adversarial UX test as meta-skill | Self-skill that runs the agent against itself for stress testing. `optional-skills/dogfood/adversarial-ux-test/`. | Our evals are external (`scripts/eval-*.js`). | ADAPT — add a `meta-self-stress` eval that drives the orchestrator through edge cases. | MEDIUM |
| 37 | Migration command (`reference claw migrate`) | Imports settings/skills/memories/keys from a prior `<HOME>/.openclaw` install. Dry-run, presets, overwrite flags. `reference_cli/claw.py`. | None — we don't have a prior install to migrate from. | NO — they migrate FROM us, not the other way around. | LOW |
| 38 | Trusted bundles | Skill bundles (`reference_cli/bundles.py`) group related skills for atomic install. | None — operator installs skills individually. | YES — add a `bundles.json` mapping `marketing-core: [..28 skills..]`, `engineering-core: [..20 skills..]`, `operator-core: [..3 skills..]`. | MEDIUM |
| 39 | RELEASE_v*.md per-version notes | Every release ships `RELEASE_v0.X.0.md` in repo root with highlights, full PR list. | We have `CHANGELOG.md` aggregated. | ADAPT — keep CHANGELOG aggregated, but emit `release-gate/release-notes/v0.X.0.md` per tagged release with the same shape. | MEDIUM |
| 40 | `/insights` summarisation | `/insights [--days N]` rolls up recent activity. `agent/insights.py`. | We have `openclaw recap [--days N]` — direct equivalent. | (already have) | — |
| 41 | `nous_rate_guard.py` | Rate-limit tracker for Nous Portal calls. | We have no portal. | NO. | LOW |
| 42 | Multi-locale gateway | `locales/` directory with i18n for messaging. `agent/i18n.py`. | None. | NO. | LOW |
| 43 | OSC8 clickable URLs | Links in agent output are real OSC8 hyperlinks. | Our CLI output is plain. | NO — cosmetic. | LOW |
| 44 | Memory provider plugins | Pluggable memory backends (mem0, supermemory, honcho, …). `plugins/memory/`. | Our `memory-adapters/` are coupled to RAG/CAG/compaction patterns, not external services. | ADAPT — define a `memory-adapter` plugin contract so operators can plug their own backend. | LOW |
| 45 | Context-engine plugins | Pluggable context-window managers. `plugins/context_engine/`. | None. | DEFER. | LOW |
| 46 | Image/video generation pluggable | One tool, pluggable backends. `plugins/image_gen/`, `plugins/video_gen/`. | None. | NO. | LOW |
| 47 | Observability plugin | Metrics/traces/logs plugin. `plugins/observability/`. | We have eval evidence under `release-gate/exports/` but no first-class observability surface. | YES — emit OTEL-shaped traces from the goal loop + bus envelopes. | MEDIUM |
| 48 | Browser CDP tool with 180x speedup | One persistent Chrome connection across calls. `tools/browser_cdp_tool.py`. | None. | NO. | LOW |
| 49 | x_search (X/Twitter) first-class | OAuth-or-API-key auth. `tools/x_search_tool.py`. | None. | NO. | LOW |
| 50 | Web search providers (Tavily/Exa/SearXNG/Brave/DDGS) | Five backends. `agent/web_search_provider.py`. | None. | NO. | LOW |
| 51 | `vision_analyze` raw pixels to vision models | Passes raw pixels straight to vision-capable models. | None. | NO. | LOW |
| 52 | Persistent skill self-improvement | Skills update during use; agent nudges itself to persist learnings. | None — skills are static in-repo. | ADAPT — write `skill-forge:` facts to the blackboard whenever the eval-runner observes drift; let the architect lane approve before the skill changes. | MEDIUM |
| 53 | `agentskills.io` spec compatibility | README claims SKILL.md is spec-v1 compatible. | We already declare Agent Skills spec v1 in README. | (already have) | — |
| 54 | Discord channel history backfill | When joining a channel, reads recent history. v0.14.0. | NO. | LOW |
| 55 | Telegram/Discord clarify buttons | Platform-native button UI for clarify questions. v0.14.0. | NO. | LOW |
| 56 | `kanban_decompose` + `kanban_specify` | Auto-decompose a goal into Kanban tasks; auto-spec a task with acceptance criteria. `reference_cli/kanban_decompose.py`, `kanban_specify.py`. | Our orchestrator decomposes lanes but lacks auto-spec acceptance criteria per lane. | YES — add `--spec` to `openclaw dispatch` that auto-derives acceptance criteria. | MEDIUM |
| 57 | Channel directory + mirror | Cross-platform routing of messages. `gateway/channel_directory.py`, `gateway/mirror.py`. | NO. | LOW |
| 58 | `RELEASE_v*.md` highlights with PR/issue counts | Each release lists "X commits · Y merged PRs · Z files changed · N insertions · M issues closed". | We track in CHANGELOG aggregated. | ADAPT — include the same shape per release-note. | LOW |
| 59 | PyPI distribution | `pip install reference-runtime`. | We're a Node-style repo only. Plugin manifests + a `package.json` exist but no `npm install -g openclaw`. | YES — add an npm-published wrapper that vendors `bin/openclaw` + `bin/openclaw-agent` so `npx openclaw goal …` works. | MEDIUM |
| 60 | Bundled MinGit on Windows installer | Self-contained git for Windows users without admin. | NO — we expect operator to have git. | LOW |
| 61 | Nix flake distribution | `flake.nix`, `flake.lock`, `nix/`. | None. | NO. | LOW |
| 62 | Docker compose | `docker-compose.yml` + `docker/`. | NO — we don't ship runtime. | LOW |
| 63 | `process_bootstrap.py` | Initial agent boot orchestration. | NO — we don't have a long-running process. | LOW |
| 64 | `iteration_budget.py` | Per-conversation iteration budget tracking. | None — our `openclaw goal` has `--max-wait-ms` but no token/iteration budget. | YES — add iteration cap to goal loop. | LOW |
| 65 | `prompt_caching.py` | Anthropic 1-hour cross-session prompt cache management. v0.14.0. | None. | DEFER — runtime concern. | LOW |
| 66 | `redact.py` | Token/PII redaction before logging. | We redact private content via `private-content-scan.js` but not in-process. | YES — extend the private-content patterns into a reusable `lib/redact.js`. | MEDIUM |
| 67 | `retry_utils.py` | Exponential backoff + jitter for provider calls. | We call `run-skill-evals.js` which has retries but not extracted as a shared util. | LOW |
| 68 | `error_classifier.py` | Classifies provider errors (rate-limit, auth, transient, fatal). | None. | DEFER. | LOW |
| 69 | `model_metadata.py` + `models_dev.py` + `models.py` | Model catalog with capabilities/pricing/context-window per model. | None — we accept any model id. | YES — add a `lib/model-catalog.json` so operators can pick by capability. | LOW |
| 70 | Account-usage tracking | `agent/account_usage.py`, `agent/usage_pricing.py`. | None. | DEFER. | LOW |
| 71 | `subdirectory_hints.py` | Generates per-directory context hints for the agent. | None — we have CLAUDE.md but no per-dir layering. | YES — add `AGENTS.md` per major directory (we already have `agents/README.md`, extend). | MEDIUM |
| 72 | `tirith_security.py` | Security advisory scanner for tool outputs. | None. | DEFER. | LOW |
| 73 | `url_safety.py`, `website_policy.py` | URL allow/block list enforcement. | None. | DEFER. | LOW |
| 74 | `osv_check.py` | OSV vulnerability check at install. | None — we run `npm audit` informally. | YES — wire `osv-scanner` into `verify-package.yml`. | MEDIUM |
| 75 | `path_security.py` | Path traversal / forbidden-path guard. | We have `agents/<role>/CONTRACT.md` forbidden-paths but no runtime check. | DEFER — runtime concern. | LOW |
| 76 | `manual_compression_feedback.py` + `conversation_compression.py` + `context_compressor.py` | Three-tier context compression. | Our memory-adapters cover compaction abstractly; no runtime compression. | DEFER. | LOW |
| 77 | `nous_subscription.py` | Subscription state for Nous Portal. | NO. | LOW |
| 78 | `model_switch.py` + `handoff` | Switch models mid-session preserving state. | NO. | LOW |
| 79 | Approval gate (`tools/approval.py`) | Interactive command-approval flow with per-session queue, dangerous-command detection, askpass-stripped sudo classification. | None. | DEFER — runtime concern. | LOW |
| 80 | `release.py` script | Tagged-release automation. | Our `scripts/package-release.js` covers this. | (parity) | — |
| 81 | Contributor audit | `scripts/contributor_audit.py` enumerates PR authors per release window. | Our `release-gate/scripts/` has no equivalent. | YES — generate co-author lists per release-notes file. | LOW |
| 82 | `lint_diff.py` | Lint only the diff against base branch. | We run full verify. | YES — add `verify --diff` mode for faster pre-push checks. | LOW |
| 83 | Plugin-aware install bundles | `<HOME>/.reference/skills/` per profile, `pip install` per provider plugin. | NO. | LOW |
| 84 | Multi-profile support (`reference -p`) | Multiple agent profiles each with isolated config/memory/skills. | NO — single ofs-now per checkout. | DEFER. | LOW |
| 85 | Profile distribution + describer | `reference_cli/profile_distribution.py` + `profile_describer.py` — describe a profile for sharing. | NO. | LOW |
| 86 | Default soul | `reference_cli/default_soul.py` — persona starter. | NO. | LOW |
| 87 | Voice mode (`tools/voice_mode.py`) | Real-time voice conversation. | NO. | LOW |
| 88 | NeuTTS local TTS samples | `tools/neutts_samples/` + `tools/neutts_synth.py`. | NO. | LOW |
| 89 | MCP OAuth manager | Multi-tenant OAuth for MCP servers. `tools/mcp_oauth.py`, `tools/mcp_oauth_manager.py`. | None — we integrate with Modern AI MCP via static config. | DEFER. | LOW |
| 90 | `reference_tools_mcp_server.py` | Exposes Reference Runtime tools as an MCP server to OTHER agent hosts. | None — we provide skills, not tools. | ADAPT — expose blackboard read/write as an MCP server so any MCP-aware host can plug in. | MEDIUM |
| 91 | `acp_registry/agent.json` | Discoverable agent.json for IDE registries. | None. | DEFER. | LOW |
| 92 | `pairing.py` flow | Out-of-band cryptographic pairing between bot and user. | We have signed envelopes but no human-side pairing. | NO. | LOW |
| 93 | Achievements plugin | Gamified usage tracking. `plugins/reference-achievements/`. | NO. | LOW |
| 94 | Strike-freedom-cockpit plugin | Internal codename, no public docs. | NO. | LOW |
| 95 | Disk-cleanup plugin | `plugins/disk-cleanup/` — clean session DB, logs. | None — we leave it to the operator. | LOW |
| 96 | Auxiliary client | Out-of-band model client for background tasks. `agent/auxiliary_client.py`. | NO. | LOW |
| 97 | Title generator | Auto-generates session titles. `agent/title_generator.py`. | None — our goals carry a title from the prompt. | LOW |
| 98 | Tool guardrails | `agent/tool_guardrails.py` — schema-validates tool calls before dispatch. | None. | DEFER — runtime. | LOW |
| 99 | Tool output limits | `tools/tool_output_limits.py` — truncate huge outputs. | None. | DEFER. | LOW |
| 100 | Tool result classification | `agent/tool_result_classification.py` — classify each result as success/transient/fatal. | None. | DEFER. | LOW |

---

## 5. Reverse Table — What We Have, Reference Runtime Doesn't

| # | Our feature | Reference Runtime equivalent | Positioning |
|---|---|---|---|
| R1 | Ed25519 signed envelopes (`src/signed-bus/`) — detached signatures over canonical JSON, every inter-agent message has cryptographic provenance. | None. Reference Runtime coordinates by SQLite Kanban CAS, no cryptographic provenance. | We have **bus-level non-repudiation** they don't. |
| R2 | JSONL blackboard ledger (`src/blackboard/`) — append-only durable log of task-claim / path-claim / path-release / fact / decision / result records. | None. Closest is the Kanban `task_events` table. | We have an **append-only auditable coordination log** they don't. |
| R3 | Formal TaskFlow FSM (`src/taskflow/`) with states queued/claimed/waiting/done/failed/blocked. | None — Kanban has status fields but no formal FSM. | We have **explicit FSM transitions** they don't. |
| R4 | Four named coordination patterns as library primitives (`lib/coordination/fan-out|fan-in|chain|voting`). | Implicit via delegate-tool batch / mixture-of-agents / kanban — no library exports for these. | We have **coordination patterns as a first-class library** they don't. |
| R5 | 11-role agent contract layer with `CONTRACT.md` per role (mission / hard preconditions / decision authority / never-do / output shape). | None — Reference Runtime has one primary agent + ad-hoc delegate children. | We have **separation-of-powers governance** they don't. |
| R6 | Production-release-gate (`security-sentinel` role + `release-gate/` machinery) with `PROPOSE_RELEASE` envelopes, operator counter-signature, manifest generation. | None — `scripts/release.py` is mechanical, no sentinel. | We have **fail-closed public-release gating** they don't. |
| R7 | Public-surface harness (`npm run verify:public-surface`) — public tree must look like a product source repo, not an incident archive. | None. | We have **first-class private/public separation enforcement** they don't. |
| R8 | Private-content scanner (`hooks/private-content-scan.js`) — blocks publication of internal emails, tilde-home paths, internal IPs, Bearer tokens before they hit a public surface. | Partial — `tools/redact.py` redacts in logs, but no pre-publication scanner. | We have **pre-publication redaction enforcement** they don't. |
| R9 | Git-push gate (`hooks/git-push-gate.js`) — block `git push` to public remote if private-content scanner finds anything. | None. | We have **terminal-side git push gating** they don't. |
| R10 | Multi-host plugin manifests in one tree (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.opencode/`). | Reference Runtime IS one of the hosts — it doesn't target multiple hosts. | We are **inter-host portable**, they are **host-themselves**. |
| R11 | Multi-model eval runner (`scripts/run-skill-evals.js`) supporting Anthropic native + OpenAI-compatible (Ollama, vLLM, OpenAI). | They have evaluation skill (`skills/mlops/evaluation/`) but not a packaged eval runner. | We have **a packaged cross-model eval harness** they don't. |
| R12 | Mock-agents harness (`openclaw goal --mock-agents`) — full synthesis trace in-process without a live agent, NATS bus, or external service. | None. | We can **exercise end-to-end coordination without a runtime** they can't. |
| R13 | Reviewer-decision schema (`release-gate/reviewer-decision-schema.md` + `.template.yaml`). | None. | We have **structured review evidence** they don't. |
| R14 | Goal operating system (`docs/goal-system.md`) — `/goal` card format, lane receipts, fail-closed verifier, synthesis loop. | Reference Runtime `/goal` is a Ralph-loop with a judge — different shape. | We have **structured goal artifacts** they have **persistent loops**. Complementary. |
| R15 | Graph system (`docs/graph-system.md`) — graph view of receipts, lane edges, blocked dependencies. | None. | We have **a coordination graph** they don't. |
| R16 | Mission Control schema (`docs/mission-control-control-plane.md`) — visual control-plane data model. | None. | We have **a control-plane schema** they don't. |
| R17 | Remote approval state parity (`docs/remote-approval-state-parity.md` + `src/remote-approval/`) — read-only approval requests + state snapshots + diff/test receipts + reviewer decisions. | Partial — they have approval flow (`tools/approval.py`) but not read-only state mirror. | We have **mirrored approval evidence** they don't. |
| R18 | Self-healing recovery eval (`scripts/eval-self-healing-recovery.js`) — stale-blocker detection, owner/action classification, unsafe auto-fix refusal, safe receipt-path retry. | None. | We have **self-healing as an eval target** they don't. |
| R19 | Security-governance eval (`scripts/eval-security-governance.js`) — quorum + approval gates + incident deductions tested. | None. | We have **governance as an eval target** they don't. |
| R20 | Frontier-orchestration-scale eval (`scripts/eval-frontier-orchestration-scale.js`) — large-fleet orchestration tested. | None. | We have **scale as an eval target** they don't. |
| R21 | Blackboard-contention eval (`scripts/eval-blackboard-contention.js`) — concurrent writers tested. | None. | We have **contention as an eval target** they don't. |
| R22 | Production-release-notes scribe lane (`agents/scribe/`) — dedicated role that owns CHANGELOG and per-release notes. | None — Reference Runtime release notes are written by release.py and humans ad-hoc. | We have **dedicated scribe authority** they don't. |
| R23 | Dependency-warden role (`agents/dependency-warden/`) — one dep per turn, escalates majors. | None — Reference Runtime uses Dependabot/Renovate organically. | We have **a dep-bump policy lane** they don't. |
| R24 | Eval-runner role (`agents/eval-runner/`) — triages eval results, proposes workflow tweaks via fact records. | None. | We have **a dedicated eval triage lane** they don't. |
| R25 | Modern AI MCP integration model (`src/integration-adapters/`). | They have MCP client + server but no opinion on MCP-as-data-backbone. | We have **MCP-as-primary-data** they have **MCP-as-tool-extension**. |
| R26 | Bus and blackboard protocol doc (`docs/bus-and-blackboard-protocol.md`) — formal protocol for multi-agent coding coordination. | None. | We have **a documented coordination protocol** they don't. |
| R27 | End-to-end trace model (`docs/end-to-end-trace.md`) — user request → release decision. | None — Reference Runtime tracks per-session, not per-release. | We have **release-decision tracing** they don't. |
| R28 | Path-claim semantics (`src/blackboard/` `path-claim` / `path-release` records). | None — Reference Runtime file ops do not claim paths cross-process. | We have **path-level exclusion** they don't. |
| R29 | Repository-initialization checklist (`docs/repository-initialization-checklist.md`). | None — Reference Runtime is one repo. | We have **a fresh-clone-verification checklist** they don't. |
| R30 | Fresh-clone-verification path (`docs/fresh-clone-verification.md`). | Reference Runtime has `setup-reference.sh` but no formal verification phase. | We have **a documented verification ramp** they don't. |
| R31 | Mock harness produces a complete trace immediately with no setup. `openclaw goal --mock-agents`. | None. | We have **out-of-the-box exercisability** they don't. |
| R32 | Watch mode (`openclaw watch --filter K --agent A --since 5m`). | They have `reference logs --follow` but it's session-log, not coordination-log. | We have **coordination-log streaming** they have **session-log streaming**. |
| R33 | Trace persistence (`--trace-dir <path>` to persist full trace JSON). | None — Reference Runtime batch trajectories serve a different purpose. | We have **per-goal trace artifacts** they have **per-conversation training data**. |
| R34 | Identity-key signed result records (`openclaw-agent --identity-key <path>`). | None. | We have **per-role cryptographic identity** they don't. |
| R35 | NATS/JetStream signed-bus implementation. | None. | We are **bus-portable** (in-process or NATS); they are **in-process only**. |

---

## 6. Architecture Comparison (~500 words)

**Synchronous vs async.** Reference Runtime is fundamentally synchronous at the
agent level. The core loop in `run_agent.py` is a single
`while api_call_count < max_iterations` over OpenAI-shape messages,
with tool calls dispatched in-process. Parallelism happens at three
specific seams: `tools/delegate_tool.py` uses a `ThreadPoolExecutor`
for parallel children, the cron scheduler runs ticks on a gateway
background thread, and the messaging gateway runs platform adapters on
separate event loops. OFS is async at the coordination level by
construction. The blackboard is a durable append-only log, agents poll
it via `openclaw-agent` daemons (one process per role), and the
signed-bus envelope transport is pluggable between in-process and
NATS/JetStream. We never assume a single process owns the conversation.

**Blackboard.** OFS has one; Reference Runtime does not. Their nearest analogue
is `kanban_db.py`'s SQLite table with `tasks / task_events / task_links
/ task_comments`, but it is not append-only, has no path-claim
semantics, and uses compare-and-swap on `status` rather than a typed
record schema. Our blackboard accepts six record kinds — `task-claim`,
`path-claim`, `path-release`, `fact`, `decision`, `result` — each with
its own validator and a canonical JSON representation suitable for
signing. The blackboard IS the coordination plane; the bus is just a
notification layer over it. Reference Runtime' coordination plane is the
conversation itself plus the Kanban DB.

**Signed envelopes.** OFS uses Ed25519 detached signatures over
canonical JSON for every inter-agent envelope, with `--identity-key`
per role. Reference Runtime has zero cryptographic envelope work — `ed25519`
appears in their codebase only as an SSH key filename string and in
their Matrix protocol adapter for identity-key extraction. They trust
the process boundary; we trust the signature on the envelope.

**Work discovery.** Reference Runtime agents discover work by listening on a
messaging platform, reading the cron tick, or being invoked from the
CLI. Subagents discover work by being spawned by the parent's
`delegate_task` call. Kanban workers discover work by polling the
SQLite board they were pinned to via `HERMES_KANBAN_BOARD` env. OFS
agents discover work by polling the blackboard for `task-claim`
records addressed to their role. Both are pull models; ours is
content-addressed against the role, theirs is process-addressed
against the parent or board.

**Role enforcement.** Reference Runtime does this at the prompt layer — each
delegate child gets a custom system prompt and a restricted toolset
via `toolsets.py`'s registry. The blocked-tools frozenset (no
recursive delegate, no clarify, no memory, no send_message, no
execute_code) is enforced by tool dispatch. OFS does this at the
contract layer — each role has a `CONTRACT.md` with hard preconditions
and forbidden-paths sections. The `openclaw-agent` daemon re-reads its
contract every turn, runs hard-rule checks on model output post-hoc,
and writes `decision` records with `status: blocked` when a NEVER rule
matches. They enforce by what tools you can call; we enforce by what
output you can ship.

**Surface area split.** Reference Runtime is a runtime; we are a substrate.
Their surface includes a CLI, a TUI, a gateway, a web dashboard, an
ACP server, an LSP integration, 22 messaging platforms, 7 terminal
backends, dozens of provider adapters. Our surface is the bus,
blackboard, taskflow, coordination patterns, agent contracts, release
gate, and skill library — designed to plug INTO Claude Code / Codex /
Cursor / OpenCode, not replace them.

---

## 7. Recommended Port List (v0.7.1 / v0.8.0)

Highest-leverage HIGH-priority items, ranked by ratio of operator
value to LOC. None of these copy reference code — they take the **idea**
and rebuild against our primitives.

### v0.7.1 (small batch, ~600 LOC)

1. **Cron-style schedule → blackboard TASK** (gap row #1).
   - **What we'd build:** `bin/openclaw-cron` daemon. Reads
     `cron/jobs.json` (operator-edited), ticks every 60 s, writes a
     `task-claim` envelope addressed to `orchestrator` (or named role)
     with the prompt as the task body. The deliver-target is just
     metadata on the envelope; downstream lanes handle delivery.
   - **Files changed:** new `bin/openclaw-cron`, new `cron/jobs.json`
     template, new `cron/lib/scheduler.js`, new `cron/test/`. Docs:
     new `docs/cron-scheduler.md`. README: add to "Included
     capabilities" list.
   - **LOC estimate:** ~400 (200 daemon, 100 tests, 100 doc).
   - **Deps:** `croniter`-equivalent in JS — use `cron-parser` (MIT,
     already an npm trustworthy pin) or hand-roll a 5-field parser.
   - **Risk:** scheduler.js needs a lockfile equivalent to reference'
     `<HOME>/.reference/cron/.tick.lock`. Use a `flock`-style lock under
     `release-gate/cron-tick.lock`.

2. **Doctor command** (gap row #14).
   - **What we'd build:** `openclaw doctor` subcommand on
     `bin/openclaw`. Checks: blackboard path exists and is appendable;
     signed-bus key (if `OPENCLAW_IDENTITY_KEY` set) parses;
     coordination patterns load; agent contracts present for every
     role under `agents/`; release-gate scripts executable; `npm run
     verify` would pass (dry-run subset).
   - **Files changed:** `bin/openclaw` (add `doctor` subcommand),
     `lib/doctor/index.js`, `lib/doctor/checks.js`, `lib/doctor/test/`.
   - **LOC estimate:** ~150 (50 dispatch, 80 checks, 20 test).
   - **Deps:** none.

3. **Supply-chain advisory check** (gap row #13).
   - **What we'd build:** `npm run verify:supply-chain` runs `npm
     audit --json` plus `osv-scanner --lockfile=package-lock.json`.
     Fails on HIGH+ vulnerabilities unless an explicit allowlist
     ack is checked in.
   - **Files changed:** `package.json` (add script), new
     `scripts/verify-supply-chain.js`, new `release-gate/lib/osv-
     allowlist.json` template. Wire into `verify-package.yml`.
   - **LOC estimate:** ~100.
   - **Deps:** `osv-scanner` binary (operator-installed) or
     `@osv-scanner/cli` if MIT-compatible.

### v0.8.0 (larger, ~2200 LOC)

4. **Webhook subscription system** (gap row #2).
   - **What we'd build:** `bin/openclaw-webhook` daemon listens on
     configurable port, validates HMAC, parses GitHub-event-shape and
     generic-JSON payloads, drops a `task-claim` envelope on the
     blackboard. Subscriptions defined in
     `webhook/subscriptions.json`. Supports GitHub (PR, issue, push),
     generic JSON. Delivery target metadata as in cron.
   - **Files changed:** new `bin/openclaw-webhook`, new
     `webhook/lib/server.js`, `webhook/lib/subscriptions.js`, new
     `webhook/subscriptions.json` template, new `webhook/test/`. Doc:
     `docs/webhook-subscriptions.md`. README: add to capabilities.
   - **LOC estimate:** ~800.
   - **Deps:** `http` (built-in), HMAC (Node `crypto`), no third-party
     server framework needed.
   - **Dependencies on:** v0.7.1 cron daemon (shared `task-claim`
     emit helper extracted into `lib/cron-emit.js`).

5. **Gateway-style event-hook lifecycle** (gap rows #3, #4).
   - **What we'd build:** extend `hooks/hooks.json` schema from the
     current `{Stop, PreToolUse}` to a richer event surface — at
     minimum `goal:start`, `goal:end`, `lane:dispatch`, `lane:result`,
     `release-gate:propose`, `release-gate:approve`,
     `release-gate:reject`. Hooks become any executable that reads a
     JSON event from stdin and optionally writes a `{decision, reason}`
     or `{context}` JSON to stdout. Consent allowlist at
     `<HOME>/.openclaw/hook-allowlist.json`.
   - **Files changed:** `hooks/hooks.json` (schema bump), new
     `lib/hooks/dispatcher.js`, new
     `lib/hooks/consent.js`, new `hooks/EXAMPLES.md`. Wire into
     `src/orchestrator/lib/goal-loop.js` so every goal-loop transition
     emits an event. New `lib/hooks/test/`.
   - **LOC estimate:** ~600.
   - **Deps:** none new; reuses our JSON envelope shape.

6. **Subagent fan-out helper** (gap row #7).
   - **What we'd build:** `lib/coordination/subagent.js`. Spawns N
     parallel child `openclaw-agent` processes (or in-process workers
     via worker_threads) with custom role + restricted toolset +
     restricted blackboard-write scope. Parent observes results via
     fan-in. Children's intermediate facts are scoped to a child-only
     blackboard slice; only the result record propagates to the parent
     scope.
   - **Files changed:** new `lib/coordination/subagent.js`, new
     `lib/coordination/test/subagent.test.js`. Update
     `lib/coordination/index.js` to export. Update
     `docs/orchestration.md`.
   - **LOC estimate:** ~500.
   - **Deps:** none new; reuses existing fan-out + role contracts.

7. **Bundles + per-release notes** (gap rows #38, #39).
   - **What we'd build:** `bundles.json` mapping bundle names to skill
     arrays (`marketing-core`, `engineering-core`, `operator-core`).
     `openclaw bundles install <name>` is metadata-only (skills are
     in-repo) but useful for plugin-host install paths. Per-release
     `release-gate/release-notes/v0.X.0.md` with the highlights +
     PR-count + insertion-count shape.
   - **Files changed:** new `bundles.json`, new
     `scripts/render-release-notes.js`, update `agents/scribe/
     CONTRACT.md` to emit per-release notes.
   - **LOC estimate:** ~300.

### Total LOC across v0.7.1 + v0.8.0

≈ 600 + 2,300 = **~2,900 LOC**, including tests and docs. Ten files
created, four edited. No new heavy runtime dependencies. All seven
items reuse the existing blackboard / signed-bus / taskflow / contract
primitives.

### Items deliberately NOT in this plan

- TUI / dashboard / messaging-gateway / ACP server — these require us
  to ship a runtime, which is a different product. DEFER.
- LSP diagnostics, file-mutation footer, computer-use, voice — runtime
  concerns that depend on owning the agent loop. DEFER.
- Skill self-improvement — interesting but requires us to commit to
  mutable skills, which conflicts with the public-release gate.
  Treat as a separate research question.

---

## 8. License + Governance Notes

**Reference Agent license:** MIT (Copyright (c) 2025 Nous Research).
Permissions: use, copy, modify, merge, publish, distribute,
sublicense, sell. Conditions: include the above copyright + permission
notice in all copies / substantial portions. Limitations: NO warranty.

**OpenClaw Frontier Stack license:** MIT (per `LICENSE`).

**Cross-compatibility:** Two MIT codebases. Adam can read their code
freely, can fork freely, can incorporate code verbatim with copyright
preservation, can ship binaries. There is no license-driven blocker to
porting any feature.

**Recommended path:** Build originals informed by what they did, same
approach used for the marketing-skills wave. The audit doc cites
reference file paths so future maintainers can reference the source idea
without needing to read their code. If at any point a verbatim
copy-paste of even a handful of lines is contemplated, attribution
must be preserved (their MIT requires the copyright notice + permission
notice in the source file).

**Governance contrast:**

- **Reference Runtime** has community Discord, `SECURITY.md`, `CONTRIBUTING.md`,
  PR-creation-policy open to all, 215 community contributors in one
  release window. Effectively a fast-moving open-source project with
  Nous Research as the maintainer.
- **OFS** has a 11-role contract layer with separation of powers —
  orchestrator dispatches but cannot approve releases; security-
  sentinel proposes releases but operator counter-signs; reviewer
  cannot approve own PRs. This is a **governance model**, not just a
  development model. Reference Runtime has nothing comparable.

**Trademark / branding:** Reference Runtime' topics list explicitly includes
`openclaw` and `clawdbot` (visible in the GitHub repo metadata). The
README pitches `reference claw migrate` as the import path from OpenClaw,
framing Reference Runtime as the successor. Our positioning should acknowledge
this — we are not "OpenClaw" the legacy `<HOME>/.openclaw` install (per
auto-memory naming-collision note); we are OpenClaw Frontier Stack,
a multi-agent coordination substrate. No trademark issue, but a clear
positioning note in the README is worth doing.

---

## 9. Honest Assessment

**Where Reference Runtime is ahead.**

On **runtime, UX, and ecosystem breadth, Reference Runtime is dramatically
ahead.** They have a polished TUI, a working web dashboard, 22
messaging platforms, 7 terminal backends, an ACP server, an LSP
integration, ~170 skills across consumer / mlops / finance / blockchain
/ security domains, a real plugin model with `ctx.llm` access, and a
self-improvement loop that adjusts skills during use. Their `pip
install reference-runtime` is a single command. Their `setup-reference.sh` is
~30 seconds to a working agent. Their docs site is a polished
Docusaurus instance. 215 community contributors in a single release
window is a strong velocity signal. They ship a release every ~30 days
at the rate of ~800 commits per release window. We do not compete on
this axis and should not try.

**Where OFS is ahead.**

On **coordination semantics, governance, and release-gate rigour, OFS
is ahead.** Our signed envelopes, durable blackboard ledger, formal
TaskFlow FSM, four named coordination patterns as library exports,
11-role separation-of-powers contracts, fail-closed public-release
gate with operator counter-signature, public-surface harness, private-
content scanner, multi-host plugin manifests in one tree, and mock-
agents harness that exercises coordination without a runtime — none of
these exist in reference. Their coordination story is "SQLite Kanban +
delegate_tool", which is fine for a personal assistant but not
sufficient for a multi-party engineering substrate. Their governance
story is "the operator trusts the process", which is fine for a
desktop tool but not for production-release decisions.

**Different-direction calls.**

On **distribution model, we are different by design.** Reference Runtime is a
runtime — install it, run it. OFS is a substrate — install it as a
plugin into whatever runtime you already use (Claude Code, Codex,
Cursor, OpenCode). The four `*-plugin/` manifests are a deliberate
inter-host portability bet. Reference Runtime is one of the hosts; we sit above
the hosts. This is a strategic choice, not a gap. The operator who
wants a runtime should use reference; the operator who already has a
runtime and wants better coordination should use OFS.

On **skills count, we are different by design.** Reference Runtime ships ~170
skills covering domains from Pokemon player to drug discovery to
hyperliquid trading. We ship 51 skills focused on ecomm marketing,
engineering workflows, and operator concerns. We are an opinionated
narrow stack; they are a broad one. The marketing-strategist role
contract explicitly drives the 28-skill marketing surface; we should
not chase parity on `finance/dcf-model` or `gaming/minecraft-modpack-
server`.

On **agent role taxonomy, we are different by design.** Reference Runtime has
one primary agent plus ad-hoc delegate children. We have 11 named
roles with `CONTRACT.md` files and hard preconditions. Their model is
fluid; ours is structured. Their model wins on UX (one chat partner);
ours wins on auditability (every decision is traceable to a role).

**The case for the v0.7.1 / v0.8.0 plan in §7.**

Each item in §7 takes an idea from reference that closes a real OFS gap
**without compromising our coordination-substrate positioning.** Cron
and webhook turn external events into blackboard task-claims (still
coordination-first). Doctor improves operator fresh-clone experience
(still substrate-first). Supply-chain advisory closes a security gap
(still governance-first). Event-hook lifecycle gives hosts the same
hook surface reference gives operators (still inter-host portable).
Subagent fan-out adds a coordination primitive without giving up
contract enforcement. Bundles + per-release notes are operator-
experience polish that reference proves out.

**What we should NOT do.**

Do not chase: messaging-gateway parity (22 platforms is a moat we
can't replicate), TUI parity (we have no runtime to TUI against),
skill-count parity (their breadth is their identity, not ours),
provider-OAuth parity (we don't own credentials), trajectory training
(we're not training models), Skin/voice/clarify-button cosmetics.

**One axis to watch.**

Reference Runtime is **explicitly positioning as the successor to OpenClaw** (see
README "Migrating from OpenClaw" section + GitHub topics
`openclaw` / `clawdbot`). They expect users to move from `<HOME>/.openclaw`
to `<HOME>/.reference` via `reference claw migrate`. This means:
1. The naming-collision risk in auto-memory is real and external —
   users in Adam's orbit may confuse OFS with the legacy `<HOME>/.openclaw`
   install reference is targeting.
2. README positioning should make clear OFS is **multi-host
   coordination substrate**, not a `<HOME>/.openclaw` continuation.
3. The branding ambiguity is not a blocker but is worth a one-line
   README disclaimer.

**Bottom line.**

OFS and Reference Runtime are not the same product. We do not need to copy them
to be valuable. The seven items in §7 are the high-leverage subset
where their ideas plug cleanly into our substrate. Past that, the
right move is to keep going deeper on coordination semantics
(governance, release gates, audit) and let them keep going broader on
runtime breadth.

---

*Audit complete. No code changes made. Single file written:
`docs/reference-runtime-audit.md`.*
