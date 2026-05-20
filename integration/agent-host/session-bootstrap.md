# Agent-host session-start bootstrap snippet

Paste this into the agent-host's session-start hook (or equivalent agent boot
script) **after** running `node integration/agent-host/install.js`. It sources
the OFS PATH shim, exports `OPENCLAW_OFS_ROOT`, and reports the
discovered OFS skills via the agent-host's own `skill-manage`.

## Bash / POSIX shells

```bash
# Source the OFS PATH shim if present. Idempotent — safe to source on
# every session start.
if [ -f "$HOME/.openclaw/agents/<label>/bin/ofs-path.sh" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.openclaw/agents/<label>/bin/ofs-path.sh"
fi

# OPENCLAW_OFS_ROOT is exported by the shim above. Surface a quick
# summary of what the agent-host will see at this session boundary.
if [ -n "$OPENCLAW_OFS_ROOT" ]; then
  printf 'session: OFS root = %s\n' "$OPENCLAW_OFS_ROOT"
  SKILL_ROOT="$HOME/.openclaw/agents/<label>/SKILLS" \
    "$HOME/.openclaw/agents/<label>/bin/skill-manage" --list 2>/dev/null \
    | head -n 20 \
    | sed 's/^/session:   /'
fi
```

## PowerShell

```powershell
# Dot-source the OFS PATH shim if present. Idempotent.
$shim = Join-Path $env:USERPROFILE '.openclaw\agents\<label>\bin\ofs-path.ps1'
if (Test-Path $shim) {
  . $shim
}

if ($env:OPENCLAW_OFS_ROOT) {
  Write-Output ("session: OFS root = {0}" -f $env:OPENCLAW_OFS_ROOT)
  $env:SKILL_ROOT = Join-Path $env:USERPROFILE '.openclaw\agents\<label>\SKILLS'
  $manage = Join-Path $env:USERPROFILE '.openclaw\agents\<label>\bin\skill-manage'
  if (Test-Path $manage) {
    & $manage --list 2>$null |
      Select-Object -First 20 |
      ForEach-Object { "session:   $_" } |
      Write-Output
  }
}
```

## What this gets you

- `openclaw`, `openclaw-agent`, `openclaw-cron`, `openclaw-webhook` are
  on PATH for the session.
- `$OPENCLAW_OFS_ROOT` points at the OFS package — useful for tools
  that want to load OFS configs or example manifests.
- `skill-manage` walks `SKILLS/` including the bridged OFS skills under
  `SKILLS/ofs/`, so the agent-host's runtime sees the full catalog.

## Not in scope

This snippet does **not**:

- Modify the agent-host's persistent PATH outside the session.
- Mutate `openclaw.json` or any operator-private config.
- Start `openclaw-cron` or `openclaw-agent` daemons — that decision
  belongs to the agent's own boot script.
