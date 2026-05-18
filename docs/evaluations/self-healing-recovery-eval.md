# Self-healing recovery eval

The self-healing recovery eval validates that the stack detects stale blockers, assigns owner/action pairs, refuses unsafe automatic fixes, and retries safe receipt-path updates.

Run it from the repository root:

```bash
node scripts/eval-self-healing-recovery.js
```

This is a local acceptance scenario. It does not require live credentials, private runtime state, or external services.
