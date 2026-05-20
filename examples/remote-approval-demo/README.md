# Remote approval/state parity demo

This demo models a production-safe remote reviewer flow inspired by frontier coding products that expose live state, diffs, tests, and approval decisions from a remote interface.

It is intentionally read-only:

- no network calls
- no credentials
- no publication or deployment
- no private runtime data
- all paths, tokens, and addresses are sanitized before packet hashes are produced

Run:

```bash
node examples/remote-approval-demo/run-remote-approval-demo.js
```

The output contains a linked approval packet:

1. state snapshot
2. diff/test receipt
3. approval request
4. reviewer decision

A reviewer can approve, request changes, or reject. The demo decision requests changes because external upload still requires explicit operator approval.
