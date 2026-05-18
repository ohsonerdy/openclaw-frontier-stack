# Remote approval/state parity prototype

This is the production-safe specification and runnable prototype for **FR-REMOTE-APPROVAL-001**.

## Goal

Expose the same review primitives a remote coding UI needs while preserving the package boundary: reviewers can inspect state, diffs, test receipts, and decisions, but the acceptance scenario cannot publish, deploy, message external systems, or mutate a live private runtime.

## Flow

1. **State snapshot** captures tasks, path claims, receipts, and test state with `readOnly: true`.
2. **Diff/test receipt** summarizes changed files and the relevant verification command/status.
3. **Approval request** links the state snapshot hash and diff receipt hash, names requester/reviewer/action/risk, and declares `mode: read-only-parity-acceptance scenario`.
4. **Reviewer decision** records `approve`, `request_changes`, or `reject`, binds to the request hash, and declares `externalEffects: false`.

## Schema summary

All records use the `openclaw-frontier.remote-approval.v1` namespace.

Required approval request fields:

- `id`
- `requester`
- `reviewer`
- `action`
- `risk`
- `stateSnapshotHash`
- `diffReceiptHash`
- `requestHash`

Required decision fields:

- `requestId`
- `requestHash`
- `reviewer`
- `decision` equal to `approve`, `request_changes`, or `reject`
- `rationale`
- `externalEffects: false`
- `decisionHash`

## Privacy and safety rules

- Payloads are operator-safe before hashes are produced.
- Common secret/token shapes, private user paths, and private overlay addresses are redacted.
- Reviewer identity must match the approval request reviewer.
- Unknown decision values fail closed.
- The prototype does not provide a writer for external approval actions; it is a parity packet and acceptance-test harness only.

## Acceptance tests

Run:

```bash
node src/remote-approval/test/remote-approval-local.test.js
node examples/remote-approval-demo/run-remote-approval-demo.js
```

The test asserts:

- snapshot, receipt, request, and decision hashes are linked
- private content is redacted
- external effects remain false
- mismatched reviewers fail
- invalid decisions fail

## Frontier gap closed

This closes the local-package slice of the remote steering gap: a reviewer can see the same operator-safe state/diff/test/decision objects that a mobile or web approval UI would need. It does not claim live mobile UI, push notifications, or external publication; those remain operator-approved integration work.
