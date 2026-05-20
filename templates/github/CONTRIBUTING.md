# Contributing

Thanks for helping improve OpenClaw Frontier Stack.

Before opening a pull request:

1. Run `node scripts/verify-package.js` from the package root.
2. Keep examples synthetic and local-only.
3. Do not include credentials, OAuth state, private hostnames/IPs, chat IDs, logs, memories, transcripts, vector stores, backups, or personal context.
4. Document new architecture surfaces in `docs/` and add a verifier or fixture when practical.
5. Update release-gate evidence if the change affects export scope, security posture, or reviewer decisions.

Pull requests should explain the artifact changed, the verification command used, and any remaining blocker.
