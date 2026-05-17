# Graph system

Status: SHIP as a production-safe capability spec.

The graph system models relationships between agents, capabilities, tasks, artifacts, reviews, releases, and communication planes. It gives Mission Control and orchestrators a shared map of what exists, what depends on what, who owns it, and which evidence supports release claims.

This spec is synthetic and portable. It must not include private hostnames, IP addresses, real chat identifiers, credentials, OAuth state, personal memory, transcripts, raw logs, live database paths, vector stores, backups, or operator-private context.

## What the graph is for

- Show which capabilities are packaged, running, planned, or blocked.
- Connect agents to roles, channels, tasks, and approval classes.
- Connect release claims to evidence and reviewer decisions.
- Let an orchestrator ask “who owns this?” without scraping prose.
- Let Mission Control render dependency and status views from a small normalized model.

## Node types

| Type | Meaning |
| --- | --- |
| `agent` | A synthetic or live agent identity. |
| `capability` | A reusable subsystem such as signed bus, blackboard, taskflow, memory, integration adapter, skill forge, communication plane, or graph. |
| `task` | A unit of work or backlog item. |
| `artifact` | A doc, template, report, demo, verifier, or release evidence file. |
| `review` | Reviewer decision or approval packet. |
| `channel` | Human-facing or machine-facing communication plane. |
| `release` | A package/export/release candidate. |

## Edge types

| Type | Meaning |
| --- | --- |
| `owns` | Agent or role owns a capability/task. |
| `implements` | Artifact or source module implements a capability. |
| `documents` | Document explains a capability, task, or release gate. |
| `depends_on` | Node requires another node before completion. |
| `verified_by` | Claim, capability, or release is checked by a verifier/review. |
| `publishes_to` | Agent or service publishes to a channel/bus. |
| `routes_to` | Router may delegate work to an agent/capability. |
| `blocks` | Node prevents another node from being ready. |

## Minimal graph record

```json
{
  "schema": "openclaw-frontier.graph.v1",
  "generated_at": "YYYY-MM-DDTHH:MM:SSZ",
  "nodes": [
    {
      "id": "capability:signed-bus",
      "type": "capability",
      "label": "Signed Bus",
      "status": "packaged",
      "risk_tier": "medium"
    }
  ],
  "edges": [
    {
      "from": "artifact:src/signed-bus",
      "to": "capability:signed-bus",
      "type": "implements"
    }
  ]
}
```

## Status vocabulary

Use only these status values for capability parity:

- `running` — live system has current evidence that the capability is active.
- `packaged` — clean package includes docs/code/templates/tests for the capability.
- `planned` — architecture exists but package/runtime is incomplete.
- `blocked` — known missing approval, access, evidence, or implementation.
- `excluded` — intentionally not part of the public release.

## Graph-to-release rule

A public release claim should be backed by at least one graph path:

`release -> documents/implements -> capability -> verified_by -> artifact/review`

If a capability is only `planned`, the release notes must call it planned and not imply it is live. If a capability is `excluded`, the package may mention the exclusion boundary but must not include private implementation detail.

## Template

See `templates/config/graph.example.json` for a small synthetic graph that installers can adapt privately.
