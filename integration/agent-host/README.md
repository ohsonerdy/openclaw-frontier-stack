# OFS -> agent-host integration

This directory wires the OpenClaw Frontier Stack (OFS) into a live mesh
agent so the agent host.s runtime can see OFS's skills, bin scripts, and v0.8
systems (cron, doctor, ticket, hooks, webhook, grading) without copying
files into the agent's home dir.

The same installer drives any number of additional agent hosts — see
`docs/integration-multi-agent-hosts.md` for cross-host notes.

## What the agent host gets from OFS

Running the installer creates four artifacts inside the agent's home:

1. **Skill bridge** — `<agent-home>/SKILLS/ofs/<skill>/` — one directory
   junction (or symlink, or copy-fallback) per OFS skill. The agent host's
   `skill-manage` walks `SKILLS/` recursively for `SKILL.md` files, so
   each bridged skill appears alongside the host.s native skills.
2. **Path shim** — `<agent-home>/bin/ofs-path.sh` and `ofs-path.ps1` —
   sourceable scripts that prepend OFS's `bin/` to `PATH` and export
   `OPENCLAW_OFS_ROOT`. the agent host.s session-start hook sources whichever
   matches the shell.
3. **Plugin manifest** — `<agent-home>/openclaw-plugins.json` — durable
   record consumed at session init. Schema
   `openclaw-agent.plugin-manifest.v1`; OFS is listed with its current
   package version, skills path, and bin path. Other plugins already
   recorded by other installers are preserved.
4. **Bus identity** (optional) — if `<agent-home>/keys/ed25519.pub`
   exists, the installer copies the public key to
   `<ofs-root>/release-gate/known-pubkeys/<label>.pub` so OFS's
   blackboard can verify envelopes the agent signs. The installer never
   reads or generates a private key.

## Install (one-line)

```
node integration/agent-host/install.js
```

Defaults: `--agent-home <user-home>/.openclaw/agents/<label>`, OFS root is
this package, label defaults to `agent-host`. Override any default:

```
node integration/agent-host/install.js --agent-home <path> --ofs-root <path>
```

For additional hosts, invoke once per host with a distinct
`--agent-home <path>` and `--agent-label <label>`.

## Dry-run

```
node integration/agent-host/install.js --dry-run
```

Prints every planned operation as `would-link`, `would-create`,
`would-update`, etc. Touches nothing on disk. Useful for confirming
agent-home detection before applying.

## Verify

After install:

1. **Skill walk:** `<agent-home>/bin/skill-manage` lists every skill it
   walks. The bridged OFS skills appear under
   `<agent-home>/SKILLS/ofs/<skill>/`.
2. **Plugin manifest:**

   ```
   cat <agent-home>/openclaw-plugins.json
   ```

   should show one entry with `id: "openclaw-frontier-stack"` and the
   current OFS version.
3. **Path shim sourced** (in the agent's session-start hook):

   ```
   source <agent-home>/bin/ofs-path.sh
   which openclaw          # -> <ofs-root>/bin/openclaw
   echo $OPENCLAW_OFS_ROOT # -> <ofs-root>
   ```

4. **Bus pubkey registered** (only if `<agent-home>/keys/ed25519.pub`
   existed at install time):

   ```
   ls <ofs-root>/release-gate/known-pubkeys/
   ```

   should contain `<label>.pub`.

## Troubleshooting

- **PATH not picked up after install.** The installer writes the shim
  but does not modify the agent's PATH. Make sure the agent's
  session-start hook sources `<agent-home>/bin/ofs-path.sh` (bash) or
  dot-sources `<agent-home>/bin/ofs-path.ps1` (PowerShell). See
  `session-bootstrap.md` for a copy-pastable hook fragment.

- **Symlinks blocked on Windows.** On Windows without developer mode,
  the installer prefers a directory `junction` (which does not require
  the `SeCreateSymbolicLinkPrivilege`). If even a junction fails (e.g.
  the destination is on a filesystem that does not support reparse
  points), the installer falls back to a recursive file-copy and logs
  the reason in the per-op output. The bridged skill is still walkable
  by `skill-manage`; the only difference is the bridge is a real copy,
  so future OFS updates require re-running the installer.

- **Skill name collision.** If a local agent skill has the same name as
  an OFS skill, the installer **refuses to install** and lists the
  collisions. Resolve manually: rename one side (preferred: rename the
  local one) or delete the conflicting local stub. Run
  `node integration/agent-host/skill-name-collision-check.js --agent-home <path>`
  for a quick pre-flight check.

- **Idempotence.** The installer is safe to re-run. Repeat invocations
  emit `already-linked` / `already-current` / `already-registered`
  statuses and touch nothing.

## Uninstall

```
node integration/agent-host/install.js --uninstall
```

Removes:

- `<agent-home>/SKILLS/ofs/` and everything beneath it (only the OFS
  bridge — pre-existing local skills are untouched).
- `<agent-home>/bin/ofs-path.sh` and `ofs-path.ps1`.
- The OFS entry in `<agent-home>/openclaw-plugins.json` (the file itself
  is removed if no other plugins remain).
- `<ofs-root>/release-gate/known-pubkeys/<label>.pub` if it was
  registered during this install.

Uninstall is itself idempotent — re-running on an already-clean home
reports `nothing-to-remove` and exits 0.

## Same wiring for additional hosts

The script is host-agnostic. From OFS's working tree, run the installer
once per host with distinct `--agent-home` and `--agent-label` values:

```
node integration/agent-host/install.js \
  --agent-home <path-to-host-2-home> --agent-label host-2
node integration/agent-host/install.js \
  --agent-home <path-to-host-3-home> --agent-label host-3
```

The bus-pubkey for each host lands under
`release-gate/known-pubkeys/<label>.pub` so the bus can verify envelopes
from every registered host. The skill bridge, path shims, and plugin
manifest are written into whichever home dir the flag points at.
