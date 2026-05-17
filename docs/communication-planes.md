# Communication planes setup

Status: SHIP as a production-safe installation runbook.

Communication planes are the human-facing chat surfaces that agents use for status, approvals, mentions, and operator-visible coordination. The default install should be seamless: configure one or more providers, create a small set of channels or topics, then bind agent routing rules to the signed bus and taskflow layer.

This document uses placeholders only. Do not commit real bot tokens, workspace ids, channel ids, user ids, invite links, OAuth state, chat exports, transcripts, or provider logs.

## Provider choices

| Provider | Best for | Notes |
| --- | --- | --- |
| Telegram | Fast mobile squad chat and mention-gated bots | Use topic/thread separation for noisy agent work. |
| Discord | Community-style channels, roles, and long-running discussion | Use least-privilege bot permissions and private ops channels. |
| Slack | Workplace-style teams, approvals, and structured project channels | Use app scopes narrowly and keep secrets in local env or secret manager. |

## Standard channel layout

Use the same conceptual layout no matter which provider is selected:

| Channel/topic | Purpose | Visibility |
| --- | --- | --- |
| `operator` | Human instructions, approvals, final summaries | Human + primary agents |
| `squad-status` | Short status updates and blockers | Human + agents |
| `squad-ops` | Deployment/runbook coordination | Restricted |
| `reviews` | Release reviews and approval packets | Reviewers + maintainers |
| `alerts` | Curated human-facing alerts only | Human + alerting agents |
| `bot-noise` | Raw smoke tests and non-human chatter | Agents only or muted |

## Install sequence

1. Pick one primary provider for operator-facing messages.
2. Create the standard channels/topics using provider-native names.
3. Create one bot/app per agent or one shared bot with strict agent identity tags.
4. Store provider secrets outside the repository.
5. Configure provider routing with placeholders from `templates/config/communication-planes.example.json`.
6. Enable mention-gating in shared human channels.
7. Route durable task/result payloads through signed bus/taskflow; keep chat messages short and human-readable.
8. Send one synthetic status message and one approval-request dry run.
9. Verify alerts are summarized before reaching humans; raw bus envelopes must stay out of human channels.
10. Record provider choice and channel layout in the private deployment notes, not in the public package.

## Provider-specific checklist

### Telegram

- Use a private group or forum topic for squad coordination.
- Keep bot privacy/mention behavior explicit.
- Pin the dashboard/wiki link only after checking the link opens for the operator.
- Never hard-code numeric chat or topic ids in public docs.

### Discord

- Create roles for operator, maintainer, reviewer, and bot/app identities.
- Grant bots only the channel permissions they need.
- Separate public discussion from private operational channels.
- Use threads for long-running review packets.

### Slack

- Use one app installation per workspace and narrow OAuth scopes.
- Prefer slash commands or buttons for approvals when available.
- Keep release reviews in a dedicated channel with message retention appropriate for the organization.
- Keep app tokens and signing secrets outside the repository.

## Routing rules

- Human-facing replies should summarize cause, impact, and recommended action.
- Agents should not echo raw signed bus JSON, smoke-test payloads, heartbeats, stack traces, or secrets into human channels.
- Destructive, external-facing, privacy-sensitive, credential-related, cost-impacting, and security-impacting actions require explicit operator approval.
- If a provider is unavailable, fall back to the signed bus/taskflow record and report a precise blocker.

## Templates

See `templates/config/communication-planes.example.json` for a provider-neutral configuration shape that installers can adapt privately.
