# Goal loop demo

Synthetic local-only demonstration of the Frontier goal operating loop.

Run:

```bash
node examples/goal-loop-demo/run-goal-demo.js
```

Outputs:

- `out/goal-card.json`
- `out/receipts/*.md`
- `out/verification-report.json`
- `out/final-synthesis.md`

The verifier intentionally fails closed: delete a receipt or remove a verdict and rerun to see the report turn RED.
