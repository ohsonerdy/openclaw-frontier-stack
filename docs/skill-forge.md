# Skill Forge

Skill Forge is the procedural/tool capability layer of OpenClaw Frontier Stack. It turns reusable workflows into safe, reviewable agent skills instead of ad-hoc prompt instructions.

## Purpose

Coding swarms need repeatable capabilities:

- inspect artifacts;
- run release gates;
- query memory;
- operate local tools;
- summarize evidence;
- perform bounded repairs.

Skill Forge packages those procedures as skills with metadata, instructions, optional scripts, and safety boundaries.

## Skill package shape

```text
skill-name/
├── SKILL.md
├── scripts/
│   └── deterministic-helper.js
├── references/
│   └── optional-reference.md
└── assets/
    └── optional-template
```

`SKILL.md` must include YAML frontmatter:

```yaml
---
name: inspect-artifact
description: Inspect a local artifact and report size, hash, and safe summary without leaking private content.
---
```

## Registry shape

Skill Forge uses a registry to make skills discoverable without loading every skill body into context.

```json
{
  "schema": "openclaw-frontier.skill-registry.v1",
  "skills": [
    {
      "name": "inspect-artifact",
      "path": "acceptance scenario-skills/inspect-artifact/SKILL.md",
      "description": "Inspect a local artifact and produce a safe summary.",
      "safety": "local-only local acceptance scenario"
    }
  ]
}
```

## Safety rules

- Skills must not contain credentials, tokens, private paths, private hostnames, or live personal context.
- Skills should prefer deterministic scripts for fragile operations.
- Skills should expose examples using synthetic files only.
- Skills should state whether they are read-only, local-only, or capable of mutation.
- Skills that can mutate files must require path claims or explicit approval in the orchestration layer.

## Acceptance scenario skill

The package includes a safe acceptance scenario skill:

`src/skill-forge/acceptance scenario-skills/inspect-artifact/`

It acceptance scenarionstrates:

- minimal `SKILL.md` metadata;
- a deterministic helper script;
- local-only inspection;
- JSON output suitable for a RESULT artifact.

This is the production-safe Skill Forge seed. Production systems can add richer tool backends after they pass release gates.
