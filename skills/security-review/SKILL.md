---
name: security-review
description: Use when auditing a PR or diff for security issues before merge. Triggers when the user mentions "security review", "is this safe to merge", "security audit", "look for vulnerabilities", "SECREVIEW", "infosec sign-off", or attaches a diff and asks "anything wrong with this from a security perspective". The output is a category-by-category review with red-flag patterns identified and remediation guidance. For systemic threat-modeling of a new feature, see threat-modeling. For supply-chain risks from dependency changes, see dependency-upgrade-safely.
metadata:
  version: 0.1.0
---

# Security review

A security review of a PR is not the same as a threat model of a system. The review is bounded to a specific diff and asks: does anything in this change introduce a vulnerability, weaken an existing control, or cross a trust boundary unsafely.

The work is pattern-matching against well-known categories, plus data-flow reasoning about what changes when the diff lands. Most vulnerabilities are not novel; they're known categories that slipped into a new piece of code because the author wasn't holding the security model in their head while writing.

Use this skill when reviewing someone else's PR, when self-reviewing before merge, or when triaging "did this dep update introduce risk".

## Step 1: scope the diff

Before reading line-by-line, scope what's changed:

- **Surface area.** Public endpoint? Internal service? CLI tool? Background job? Affects the security model differently.
- **Trust boundary crossed.** Is user-controlled input now reaching this code path? Is privileged data being exposed? Is a privilege check being added, removed, or moved?
- **New auth/authz code.** Always extra scrutiny.
- **New persistence.** Schema changes, new fields, new tables. May affect data exposure or retention.
- **New external calls.** Outbound HTTP, message queue publishes, new API integrations. New attack surface for SSRF, data exfiltration.
- **Cryptographic code.** Always extra scrutiny. The bar for writing crypto is "use a vetted library and don't touch the primitives".

If the diff has none of the above and is purely refactoring within a well-understood area, the review can be quick. If it has any of them, slow down.

## Step 2: walk the OWASP categories

For each category, look for the specific red-flag patterns in the diff. This is not a checklist to complete; it's a mental model to apply.

### A1: Broken access control

The question: does this diff perform an action that requires permission, and is the permission check correct?

Red flags:
- A new endpoint or handler with no apparent authorization check. Search the diff for the symbol that performs auth — if it's absent, ask.
- Authorization done at the wrong layer (controller checks, but the model is reused from another path that doesn't). Authz at the model or service layer is more robust.
- Authorization based on data that the user controls. "Allow if `request.user_id == resource.user_id`" is fine if `request.user_id` comes from the verified session, dangerous if it comes from a request parameter.
- Mass-assignment of fields. A new endpoint that accepts a JSON object and assigns it to a model can let users set fields they shouldn't (e.g. `is_admin: true`). Always allowlist the writable fields.
- Resource lookup that doesn't scope by tenant or owner. `Order.find(params[:id])` returns any order; the correct call is `current_user.orders.find(params[:id])`.

### A2: Cryptographic failures

The question: is sensitive data protected in transit, at rest, and in logs?

Red flags:
- Hand-rolled crypto. No team should be writing block-cipher modes; use the library.
- Weak hash for passwords. MD5, SHA-1, plain SHA-256 are all wrong for passwords. Bcrypt, scrypt, argon2 are the right choices.
- Hardcoded keys or secrets. Any literal that looks like a key, token, or password in the diff is a finding. Even "for testing" — test keys leak.
- Insufficient randomness. `Math.random()` and equivalents for security purposes (token generation, session IDs) are wrong. Use cryptographic randomness primitives.
- TLS misconfiguration. Disabling certificate verification, accepting self-signed certs in production, pinning to weak protocols.

### A3: Injection

The question: does any user-controlled input flow into a sensitive sink (SQL, shell, HTML, OS command, log injection)?

Red flags:
- SQL string concatenation. `"SELECT * FROM users WHERE id = " + user_input` is always wrong. Parameterized queries always. ORM helpers are fine; raw string interpolation is not.
- Shell command construction. `system("convert " + user_filename + " out.png")` is a shell injection waiting to happen. Use the argv form: `system("convert", user_filename, "out.png")`.
- HTML output without escaping. New view that renders user-controlled data needs to escape it. Frameworks usually escape by default; bypassing the default (`raw`, `unsafe`, etc.) is a red flag.
- Template injection. User input passed as a template (server-side rendering of user-supplied templates) is its own category of injection.
- Log injection. Logging user input verbatim can let attackers forge log entries. Sanitize newlines and control characters before logging.

### A4: Insecure design

Broader than the others. The question: is the feature designed in a way that makes security failures likely?

Red flags:
- Trust models that rely on the client. Anything that says "the client tells us X, we trust it" needs scrutiny. The client is in the threat model.
- Multi-step flows without state binding. Step 1 sets up an authorization; step 2 acts on it. If step 2 doesn't re-verify the state from step 1, attackers can race or forge.
- No rate limiting on expensive operations. Login, password reset, search, signup — anything that costs the system and is reachable without auth.
- No CSRF protection on state-changing endpoints. If the endpoint mutates state and is reachable from a browser, it needs CSRF protection (or to be JSON-only with strict CORS).

### A5: Security misconfiguration

The question: does the diff change configuration that affects security posture?

Red flags:
- Permissive CORS. `Access-Control-Allow-Origin: *` on an authenticated endpoint is wrong.
- Permissive CSP. `default-src *` is no CSP. Tightening is safer than loosening.
- Disabling security middleware. Look for any commented-out or removed security headers, CSRF middleware, rate limit middleware.
- Verbose error responses. Stack traces in 500 responses leak internal structure to attackers.
- Default credentials. New service deployed with admin/admin, or any literal default.
- Wildcards in IAM / RBAC. `Action: "*"` is a finding; ask if the actual needed scope is smaller.

### A6: Vulnerable and outdated components

The question: do dependency changes introduce known-vulnerable code?

Red flags:
- New dep with a published CVE not yet patched.
- Dep downgraded to a known-vulnerable version.
- New dep with no published security policy or recent maintenance.

This category is `dependency-upgrade-safely` territory; cross-reference there for the deeper procedure.

### A7: Identification and authentication failures

The question: are auth flows correctly implemented?

Red flags:
- Session tokens transmitted in URL parameters (logged, leaked via referer).
- Missing logout that clears the session server-side.
- Password reset flows without token expiry or single-use enforcement.
- Account lockout policies that allow username enumeration (different responses for "username doesn't exist" vs "wrong password").
- 2FA backup codes that can be reused indefinitely.

### A8: Software and data integrity failures

The question: does the diff introduce a path where data integrity can be subverted?

Red flags:
- Deserialization of user-controlled data. Especially Python pickle, Java native serialization, PHP unserialize. JSON parsers are usually safe; native serializers are not.
- Unsigned update mechanisms. Auto-update without signature verification.
- Inclusion of remote scripts at runtime. `<script src="//cdn.example.com/...">` without integrity attributes.

### A9: Security logging and monitoring failures

The question: would we know if this were attacked?

Red flags:
- Failed auth attempts not logged.
- Privilege escalation events not logged.
- Logs that include sensitive data (passwords, tokens, PII) — too much logging.
- Logs that don't include the actor — too little.

### A10: Server-side request forgery (SSRF)

The question: does the diff make an outbound HTTP request based on user input?

Red flags:
- Fetch a URL the user supplied. Without restrictions, this can be used to probe internal networks or extract data from metadata endpoints.
- Image / file upload by URL. Same risk as above.
- Webhook subscriptions. If the user controls the URL, they can target internal endpoints.

Mitigations: allowlist of permitted hosts, blocklist of private IP ranges and metadata endpoints, DNS resolution before connect (and re-validation).

## Step 3: data flow through the diff

Beyond the category walk, trace data flow:

- **User-controlled inputs.** Where do they enter? What happens to them on the way to a sink?
- **Sensitive data.** Where does it live? Who can read it? Where does it leave the system (logs, error responses, outbound calls)?
- **Trust boundaries.** Where does untrusted data become trusted? Is there validation at that boundary?

This is harder than category-matching but catches issues that don't fit any single category. The question to keep asking: "if I were attacking this, where would I push?"

## Step 4: secret handling

Specific rules that come up often:

- **No secrets in code.** Ever. Tests included.
- **No secrets in logs.** Headers redacted, body fields like `password` and `token` redacted before logging.
- **Secrets from a secret manager or env, not from a config file in git.**
- **Rotation cadence specified.** Even if the rotation isn't done in this diff, the model for rotating should exist somewhere.
- **No secrets in error messages returned to clients.** Stack traces, config snippets, internal hostnames — all can leak via error responses.

The diff-time question: any new field that looks like a secret, any new endpoint that could expose one, any log line that could include one.

## Step 5: authn vs authz boundary

Confusion between authentication (who is this user) and authorization (what is this user allowed to do) is one of the more common security bugs.

- **Authentication.** Identity check. Happens once per session. The output is a verified identity attached to subsequent requests.
- **Authorization.** Permission check. Happens on every action. The output is allow/deny for this specific action against this specific resource.

Red flag: a diff that performs authentication and then assumes authorization is implied. Authenticated does not mean authorized. A user signed in is not the same as a user allowed to delete this resource.

The discipline: authorization is checked at the layer that performs the action, not at the layer that received the request. Controllers can authenticate; only the service or model layer should authorize, because that's where the action actually happens.

## Step 6: dependency-introduced risk

If the diff adds or upgrades dependencies, run the additional checks from `dependency-upgrade-safely`. Highlights:

- New dep adds new transitive deps; check the new tree.
- New dep's maintainer signal (recent releases, response to issues).
- New dep's permissions / capabilities. A dep that needs network access expands the egress surface.
- New dep replaces an existing dep — check that the migration didn't drop a security feature.

## Common review failures

- **Reviewing only what changed in the diff.** The diff is necessary but not sufficient. The surrounding code is what makes the diff safe or unsafe. Read the function the change is in, not just the lines.
- **Trusting that "the framework handles it".** Sometimes true (escape by default, CSRF middleware). Always verify the framework's default behavior is actually in effect.
- **Treating "tests pass" as security validation.** Tests catch known cases. Security review is for unknown cases.
- **Reviewing the happy path only.** Most vulnerabilities are in the error paths, the edge cases, the legacy code paths the change didn't intend to touch.
- **Skipping the review when "it's just a small change".** Most production security incidents come from small changes.

## What you do NOT do in this review

- **Recommend specific CVEs or attack-incident framings.** Patterns are durable; specific historical incidents are noise. Stay in pattern-space.
- **Block the PR without a remediation suggestion.** Every finding has either a fix or an accept-with-mitigation.
- **Approve "looks good" without listing the categories considered.** A bare approval offers no evidence the review happened.

## Output format

When this skill is invoked, produce:

1. **Diff scope** — surface area, trust boundary crossings, classes of code changed.
2. **Category findings** — for each OWASP category, either "no findings" or specific findings with file:line references.
3. **Data flow concerns** — issues that span multiple categories or arise from how the diff fits the existing code.
4. **Dependency risk** — if deps changed, the supply-chain assessment.
5. **Suggested remediations** — for each finding, the specific fix.
6. **Verdict** — approve, request changes, request more context. Each verdict is justified by the findings above.

## Related skills

- `threat-modeling` — for the systemic version of this work, before the diff exists.
- `dependency-upgrade-safely` — for the supply-chain side; many security reviews trigger this.
- `architecture-decision-records` — when the review surfaces a decision worth recording (e.g. "we accept X risk because Y").
- `incident-response` — if the review uncovers an active vulnerability that's already deployed.
