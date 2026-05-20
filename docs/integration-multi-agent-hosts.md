# Integrating OFS into multiple agent hosts

The OpenClaw Frontier Stack (OFS) ships an installer at
`integration/agent-host/install.js` that wires OFS's skills, bin scripts, and
plugin manifest into a live agent-host home directory. The same script drives
any number of distinct hosts — the only difference per host is which
home-dir path and label you pass.

This doc is the cross-host guide. For per-host install/verify steps,
see `integration/agent-host/README.md`. For a copy-pastable session-start
hook, see `integration/agent-host/session-bootstrap.md`.

## Host model

Each agent host is expected to expose a home directory containing:

- `SKILLS/` — directory the host walks recursively for `SKILL.md` files
- `bin/` — directory the host adds to `PATH` at session start
- `keys/ed25519.pub` (optional) — the host's signing pubkey; the
  installer copies it to OFS's `release-gate/known-pubkeys/<label>.pub`
  so the bus can verify envelopes the host signs

The installer never creates a keypair — it only registers a pubkey that
already exists in the host's `keys/` dir.

## Per-host install command

From OFS's working tree, run once per host with distinct `--agent-home`
and `--agent-label` values:

```
node integration/agent-host/install.js \
  --agent-home <path-to-host-home> \
  --agent-label <short-name>
```

Defaults: when `--agent-home` is omitted, it's computed as
`<user-home>/.openclaw/agents/<label>`. When `--agent-label` is omitted,
it defaults to `agent-host`. The label is what shows up in
`release-gate/known-pubkeys/<label>.pub` and in the OFS plugin manifest.

## Multi-host install example

```
node integration/agent-host/install.js \
  --agent-home /path/to/host-1-home --agent-label host-1
node integration/agent-host/install.js \
  --agent-home /path/to/host-2-home --agent-label host-2
node integration/agent-host/install.js \
  --agent-home /path/to/host-3-home --agent-label host-3
```

Each invocation is independent. Re-running an already-installed host is a
no-op (the installer is idempotent).

## Verification per host

After each install, verify the bridge state from the host's home dir:

```
ls <agent-home>/SKILLS/ofs/                    # should list bridged OFS skills
cat <agent-home>/openclaw-plugins.json         # should include openclaw-frontier-stack
ls <ofs-root>/release-gate/known-pubkeys/      # should contain <label>.pub (if host has keys/ed25519.pub)
```

## Uninstall per host

```
node integration/agent-host/install.js \
  --agent-home <path-to-host-home> --agent-label <short-name> --uninstall
```

Idempotent — re-running on an already-clean home reports
`nothing-to-remove` and exits 0.

## Cross-host invariants

The installer guarantees:

1. **No keypair generation.** Pubkey-only registration. Private keys never
   leave the host.
2. **No env mutation.** The installer writes the path shim
   (`bin/ofs-path.sh` and `ofs-path.ps1`) but does NOT modify the
   operator's shell rc files (bashrc, zshrc, profile.ps1) or persistent
   `PATH`. The session-start hook sources the shim explicitly.
3. **Idempotent.** Re-running yields zero new operations.
4. **Reversible.** `--uninstall` removes every artifact the installer
   created (symlinks, shims, manifest entry, bus-pubkey registration).

## Skill-name collision check (pre-install)

Before installing, you can dry-run a collision check to see whether any
OFS skill names collide with skills already in the host's `SKILLS/`:

```
node integration/agent-host/skill-name-collision-check.js \
  --agent-home <path-to-host-home>
```

Exits 0 with no collisions; 1 if any collisions are reported. Resolve
collisions (rename or remove the host-side skill) before invoking the
installer.

## Multi-host operations

Each registered host can publish envelopes to the OFS bus using its
declared NKey. The bus verifies the signature against the pubkey at
`release-gate/known-pubkeys/<label>.pub`. From the bus's perspective,
hosts are identified by label only — the persona, hardware, or location
of any given host is not part of the public protocol.

## Cleanup of stale pubkeys

If you uninstall a host (`--uninstall`), the pubkey is also removed from
`release-gate/known-pubkeys/`. If you ever rename a host's label, the old
pubkey under the previous label remains in place — clean it up manually
with `git rm release-gate/known-pubkeys/<old-label>.pub` and commit.
