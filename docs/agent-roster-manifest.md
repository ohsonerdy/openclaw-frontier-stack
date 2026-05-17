# Agent roster manifest

Status: SHIP as a production-safe coordination template.

The agent roster manifest is the small shared file that tells a fleet which agents exist, what they own, and which coordination channels they use. It is intentionally generic: it describes roles and capabilities without carrying private hostnames, addresses, credentials, chat ids, personal context, or live operational logs.

## Purpose

Use the roster to answer:

- Which agent owns a work lane?
- Which agent can safely receive a task class?
- Which runtime channel should an orchestrator use first?
- Which agent is only advisory and must not execute changes?
- Which capabilities require explicit operator approval?

## Required fields

Each roster entry should include:

| Field | Meaning |
| --- | --- |
| `agent_id` | Stable lowercase id used in bus envelopes and task routing. |
| `display_name` | Human-readable name. |
| `owner_host_label` | Synthetic host label such as `host-a`; never a live hostname/IP. |
| `primary_roles` | Short role list, e.g. `coordination`, `review`, `docs`, `ops-advisory`. |
| `capabilities` | Bounded capability names the orchestrator may match against. |
| `coordination_channels` | Generic channel labels such as `signed-bus` or `taskflow`. |
| `risk_tier` | `low`, `medium`, or `high`; high tier requires operator approval before action. |
| `approval_required_for` | Explicit action classes requiring approval. |
| `status_source` | Production-safe heartbeat or status artifact path/pattern. |

## Non-goals

The roster is not a secret store, access-control list, deployment inventory, session log, personal memory index, or domain-authority file. It should not include live endpoints, tokens, OAuth material, private paths, raw logs, database paths, vector-store paths, backups, personal scheduled jobs, or user-private context.

## Orchestrator behavior

An orchestrator may use the roster to shortlist candidate agents, then apply live load, freshness, permission, and risk checks before delegation. The roster alone must not authorize destructive, external, privacy-sensitive, regulated, or security-impacting actions.

## Example

See `templates/config/agent-roster.example.json` for a synthetic, production-safe manifest shape.
