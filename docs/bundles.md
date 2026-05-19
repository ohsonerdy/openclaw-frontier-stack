# Skill bundles — operator guide

The OpenClaw Frontier Stack ships a large skill catalog. Most operators
do not want the full surface installed in a single plugin host; they
want a coherent slice that matches the work they do.

`bundles.json` at the repo root is the answer. It names curated groups
of existing skills so plugin hosts (Claude Code, Codex CLI, Cursor,
OpenCode) and downstream tooling can install a focused subset rather
than the full catalog.

Bundles are **metadata only**. They do not duplicate skill content. The
skills referenced by a bundle already live under `skills/<name>/` and
ship with the package; the bundle just names a coherent set of them.

## When to use a bundle

Reach for a bundle when:

- You are onboarding a new operator and want a focused starter set
  rather than the full 68-skill catalog.
- You are wiring the stack into a plugin host whose install surface
  is per-skill, and you want the install command to point at a named
  group rather than enumerate every skill by hand.
- You are documenting a workflow (operator runbook, customer guide,
  release-gate recipe) that depends on a coherent skill subset.

Skip a bundle when:

- You only need one or two skills. Install those skills directly.
- The work cuts across so many domains that the full catalog is
  warranted. The bundle layer is for focused slices, not for
  "everything".
- You need an operator-specific override (e.g. you want all of
  `marketing-core` minus one skill, plus three from a different
  bundle). In that case, copy the skill list inline rather than
  reference a bundle that does not match what you want.

## Schema

`bundles.json` declares its schema with the `schema` field at the top
level:

```json
{
  "schema": "openclaw-frontier.bundles.v1",
  "version": "1.0.0",
  "description": "...",
  "bundles": {
    "<bundle-name>": {
      "description": "<one paragraph describing the slice>",
      "skills": [
        "<skill-name-1>",
        "<skill-name-2>"
      ]
    }
  }
}
```

Rules enforced by the verifier:

- `schema` must equal the literal string `openclaw-frontier.bundles.v1`.
- `version` is a semver string. Bumping the version is editorial; the
  schema field gates breaking-change consumers.
- Every entry under `bundles` has a `description` (single paragraph,
  operator-readable) and a `skills` array of strings.
- Every string in a `skills` array must name an existing directory at
  `skills/<name>/` that contains a `SKILL.md`. The package verifier
  refuses to ship a manifest that references a non-existent skill.

The current bundle set (see `bundles.json`):

- `marketing-core` — Modern Skills marketing essentials.
- `marketing-extended` — broader marketing surface (ads, pricing,
  programs, AI-creative).
- `engineering-core` — incident lifecycle, ADRs, API/schema design,
  refactoring safety, monitoring basics.
- `engineering-reliability` — on-call, deploys, capacity, DR, load,
  backups, change management.
- `engineering-security` — review, threat modeling, secrets,
  dependency hygiene, audit rituals.
- `operator-core` — three host-neutral procedural skills that ship the
  operator-safe release pipeline.
- `agent-substrate` — cross-cutting skills for building on top of the
  agent runtime (signed-bus, ticketing, goal-loop).

A given skill may appear in more than one bundle. That is intentional;
bundles are slices, not partitions.

## How to add a new bundle

1. Choose a slice name (kebab-case, two-token preferred, e.g.
   `growth-essentials` not `gr` or `marketing growth essentials v2`).
2. Write the description as a single paragraph that names the audience
   ("operators running...") and the shape of the slice ("covers...").
3. List the skill members. Every member must already exist under
   `skills/<name>/` at the target tree — bundles do not introduce new
   skills.
4. Add the bundle entry to `bundles.json`.
5. Run `node -e "JSON.parse(require('fs').readFileSync('bundles.json','utf8'))"`
   to confirm the file still parses. The package verifier runs the
   same check on every release candidate.

Do not:

- Edit a bundle to point at a skill that does not yet exist on disk.
  That is the failure mode the verifier blocks.
- Add bundles whose membership overlaps another bundle by more than
  about half its members. Two near-identical bundles confuse the
  install path. Either merge or differentiate.
- Reference private, non-public, or operator-personal skills. The
  catalog is public-package only; the bundle file is too.

## How plugin hosts consume bundles

Plugin hosts read `bundles.json` from the package root. The shape is
host-agnostic so the same file serves every host:

- A host that supports per-skill install (Claude Code, Codex CLI,
  Cursor, OpenCode) iterates the `skills` array for the selected
  bundle and installs each skill directory under `skills/<name>/` as
  if the operator had named it directly.
- A host that supports plugin-level configuration only references the
  bundle name in its plugin manifest, and the host's installer
  resolves the membership at install time.
- A host that ships its own catalog UI shows the bundle description
  next to the bundle name; the description is the operator-facing
  copy.

The package verifier proves the bundles file is well-formed
(`bundles-json-valid` check). Bundle-aware install behavior lives in
the host or in tooling layered on top of the package; the package
itself ships the manifest, not the install path.
