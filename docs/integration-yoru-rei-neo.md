# Integrating OFS into Neo, Yoru, and Rei

The OpenClaw Frontier Stack (OFS) ships an installer at
`integration/neo/install.js` that wires OFS's skills, bin scripts, and
plugin manifest into a live mesh-agent home directory. The same script
drives all three squad agents — the only difference per host is which
home-dir flag points to which path.

This doc is the cross-host guide. For Neo-specific install/verify steps,
see `integration/neo/README.md`. For a copy-pastable session-start hook,
see `integration/neo/session-bootstrap.md`.

## The three squad agents

| Agent | Host     | Typical home dir                              | Bus label |
|-------|----------|-----------------------------------------------|-----------|
| Neo   | BEEF     | `<user-home>\.openclaw\agents\neo`            | `neo`     |
| Yoru  | MBP      | `<user-home>/.openclaw/agents/yoru`           | `yoru`    |
| Rei   | CONSTRUCT| `<user-home>/.openclaw/agents/rei`            | `rei`     |

Each agent's home dir is expected to contain `SKILLS/`, `bin/`, and
(optionally) `keys/ed25519.pub`. The installer never creates a
keypair — only registers a pubkey that already exists.

## Per-host install command

From OFS's working tree:

```
# Neo on BEEF
node integration/neo/install.js --neo-home <neo-home>

# Yoru on MBP
node integration/neo/install.js --yoru-home <yoru-home>

# Rei on CONSTRUCT
node integration/neo/install.js --rei-home <rei-home>
```

Each `--*-home` flag auto-sets the bus label appropriately:
`--neo-home` -> `neo`, `--yoru-home` -> `yoru`, `--rei-home` -> `rei`.
The label is the only thing that decides the filename under
`release-gate/known-pubkeys/<label>.pub`, so registering all three from
the same OFS checkout produces:

```
release-gate/known-pubkeys/
  neo.pub
  yoru.pub
  rei.pub
```

OFS's blackboard / envelope verifier can then validate signed records
from any of the three agents from a single trust store.

## What lands per host

On every host, the installer performs the same four operations:

1. **Skill bridge** — one directory junction (or symlink, or
   copy-fallback) per OFS skill at `<agent-home>/SKILLS/ofs/<skill>/`.
2. **Bin path shim** — `ofs-path.sh` (bash) and `ofs-path.ps1`
   (PowerShell) under `<agent-home>/bin/`.
3. **Plugin manifest** — `<agent-home>/openclaw-plugins.json` listing
   OFS as an installed plugin with its current version, skills path,
   and bin path. Pre-existing entries from other plugins are preserved.
4. **Bus identity (optional)** — copy of the agent's
   `keys/ed25519.pub` to `release-gate/known-pubkeys/<label>.pub`. If
   no pubkey exists yet, this step is skipped with a warning and the
   rest of the install continues.

The installer is idempotent. Re-running it on any host yields
`already-*` statuses across the board.

## Platform notes

- **Windows (Neo on BEEF):** the installer uses `fs.symlink` with
  `type: 'junction'` for the skill bridge. Junctions do not require
  developer-mode or `SeCreateSymbolicLinkPrivilege` and work on NTFS
  volumes from any user account. If junction creation fails (rare —
  typically non-NTFS, network share, etc.) the installer falls back to
  a recursive file-copy and logs the reason in the per-op output.

- **macOS (Yoru on MBP):** the installer tries the `junction` type
  first, then falls back to a directory symlink (`type: 'dir'`). On
  macOS the junction request silently degrades to a symlink, which is
  the correct behavior on a POSIX filesystem.

- **Linux (Rei on CONSTRUCT):** same as macOS — directory symlinks via
  `fs.symlink(..., 'dir')`.

In all cases, the bridge mode is reported per op (`linked`,
`copied-fallback`) so an operator running with `--json` can see exactly
what landed.

## Verifying across hosts

After install on a given host:

```
# Show the OFS plugin manifest
cat <agent-home>/openclaw-plugins.json

# Walk the bridged skill catalog the way skill-manage will
SKILL_ROOT=<agent-home>/SKILLS <agent-home>/bin/skill-manage --list

# Confirm bus-pubkey landed (from OFS checkout root)
ls release-gate/known-pubkeys/
```

If any host's `skill-manage` does not see the bridged skills, check
that `SKILLS/ofs/<skill>/SKILL.md` is reachable — the bridge target
must contain a real `SKILL.md` for the walker to count it.

## Uninstall

```
node integration/neo/install.js --uninstall --neo-home <neo-home>
node integration/neo/install.js --uninstall --yoru-home <yoru-home>
node integration/neo/install.js --uninstall --rei-home <rei-home>
```

Each removes only its own bridge, shims, plugin manifest entry, and
known-pubkey file. Other agents' installs are untouched.

## When to re-run the installer

- After upgrading OFS to a new version: the plugin manifest's `version`
  field is the durable record of what's installed. Re-running the
  installer updates the version and is otherwise a no-op.
- After adding a new OFS skill: re-run the installer to bridge the new
  skill. Existing bridges are reported `already-linked` and untouched.
- After rotating an agent's Ed25519 keypair: re-run the installer; the
  pubkey file under `release-gate/known-pubkeys/<label>.pub` is updated.

## Not in scope for the installer

- Generating private keypairs. The installer never does this.
- Modifying the agent's session-start hook. Operators paste the snippet
  from `integration/neo/session-bootstrap.md` themselves so they can
  audit what runs at session boundaries.
- Updating CHANGELOG.md, marketplace manifests, or any other
  release-gate metadata. Those are handled upstream.
