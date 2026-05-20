---
name: api-design
description: Use when designing a new HTTP/RPC API or evolving an existing one without breaking consumers. Triggers when the user mentions "design this API", "REST vs GraphQL", "endpoint design", "API versioning", "breaking change", "API contract", "should this be one endpoint or two", "pagination", or "error response shape". The output is a contract that consumers can build against confidently and that the team can evolve without scheduled flag days. For the durable record of the resulting decisions, see architecture-decision-records. For the storage layer those endpoints touch, see schema-design.
metadata:
  version: 0.1.0
---

# API design

A good API design hides the system's complexity behind a contract that consumers can rely on for years. A bad design leaks implementation details, breaks on every internal refactor, and forces consumers into versioning gymnastics.

The skill is to think in contracts, not endpoints. Endpoints are how the contract is expressed; the contract itself is what consumers depend on.

## When to use this skill

- New public or partner-facing API surface.
- Internal API that crosses an org boundary (multiple teams consume).
- Major reshape of an existing API (new resource model, versioning bump).
- Backwards-incompatible change to an existing endpoint (even one).
- Choosing between REST, GraphQL, gRPC, or a hybrid.

For a single new endpoint on an existing well-designed API, you may not need the full skill — follow the existing patterns. For anything that establishes new patterns, run the procedure.

## Step 1: clarify the audience

The first question is who consumes this API. The right answer shapes everything that follows.

- **Internal-only, single consumer.** You can co-evolve the API and the consumer. Prefer simplicity and speed of change. RPC-shaped (single language, shared types) is often best.
- **Internal-only, multiple consumers.** Need a stable contract, but you control all the consumers. Can change with coordinated deploys. REST or gRPC with versioning is typical.
- **External partners.** Need a stable contract and deprecation windows. Cannot break without notice. REST with strict versioning, or GraphQL if the partners need flexible field selection.
- **Public / third-party developers.** Need a stable contract, public docs, predictable evolution, ideally OpenAPI/SDL spec. Most conservative posture; treat all changes as expensive.

The conservation of change-cost is real: the more external the audience, the higher the cost of a change. Design for the audience you actually have, plus one step out — internal APIs often become external eventually.

## Step 2: choose the protocol shape

The decision is not abstract. Each option has concrete tradeoffs.

### REST

Best when:
- The domain is naturally resource-oriented (entities with CRUD).
- Caching is important (HTTP caching primitives are mature).
- The audience is heterogeneous (browsers, mobile, partners) and HTTP is the lingua franca.
- Long-term stability matters more than per-call efficiency.

Avoid when:
- The domain is verb-oriented (workflows, computations, RPC-shaped).
- The client needs flexible field selection across nested resources.
- Latency budget is tight and N+1 round trips kill the budget.

### GraphQL

Best when:
- Clients need flexible field selection (mobile vs desktop, partner A vs partner B).
- The data model is graph-shaped (deeply nested with many cross-cutting queries).
- A single endpoint with introspection is acceptable.

Avoid when:
- Caching at the HTTP layer matters (GraphQL undermines it).
- The team doesn't want to operate the query-cost analyzer needed to prevent abuse.
- Most clients use a small fixed set of queries (the flexibility is unused overhead).

### gRPC / RPC

Best when:
- Internal service-to-service communication where both sides are controlled.
- Strict typing across language boundaries is valuable.
- Streaming or bidirectional patterns are common.
- The clients are all internal services with code-generated stubs.

Avoid when:
- The audience includes browsers (requires gRPC-Web shim and adds friction).
- Public consumers will hand-write clients (RPC schemas are less ergonomic than REST for that).
- HTTP caching primitives are important.

### Hybrid

It is common to expose REST for public consumers and gRPC for internal. This is fine; the cost is maintaining two surfaces. The discipline is that both surfaces wrap the same underlying domain logic — the API is the interface, the domain logic is the implementation.

## Step 3: model resources vs RPCs

Even within REST, there's a choice: do you model the API as resources (nouns) or as actions (verbs)?

Resource-modeled REST: `POST /users`, `GET /users/{id}`, `PATCH /users/{id}`, `DELETE /users/{id}`.
RPC-modeled REST: `POST /users/create`, `POST /users/get`, `POST /users/update`, `POST /users/delete`.

Resource modeling works when the domain has clear entities and the operations are predictable CRUD. RPC modeling works when the operations don't map cleanly to entities, or when the operations are verb-driven (e.g. `POST /transfers/initiate`, `POST /reports/generate`).

Don't try to force everything into resource modeling. If you have an endpoint that's clearly an action ("send this email", "trigger this workflow", "compute this report"), an RPC-shaped endpoint is honest. Hiding it behind a fake resource (`POST /email-send-requests`) is worse.

## Step 4: versioning strategy

Pick one and commit:

- **URL path versioning** (`/v1/users`, `/v2/users`). Easiest to reason about, easiest to route, easiest to deprecate. The cost is that "v1" and "v2" become two complete APIs to maintain. Default for public REST.
- **Header versioning** (`Accept: application/vnd.example.v2+json`). Cleaner URLs, harder to debug, harder for partners to specify. Avoid unless you have a strong reason.
- **No explicit version, additive-only** (any change is non-breaking). Lower friction but requires extreme discipline. Works internally where consumers can be coordinated; usually fails externally.
- **Semantic-version-style on request** (`X-API-Version: 2.3`). Hybrid; some flexibility but operationally complex.

The single biggest mistake is treating versioning as a tax and deferring the decision until the first breaking change forces it. The first version IS the decision — name it `/v1` from day one if you'll ever break compat.

## Step 5: design the error shape

Every API needs a consistent error response shape. The two paths:

### RFC 7807 problem+json

A standardized shape: `type`, `title`, `status`, `detail`, `instance`, plus extension fields. Best when interoperability matters, when consumers might use generic error-handling middleware, or when the API is public.

```json
{
  "type": "https://example.com/errors/insufficient-balance",
  "title": "Insufficient balance",
  "status": 422,
  "detail": "Account 4d5b has balance 12.40, requested debit 25.00",
  "instance": "/transfers/9a8c7b"
}
```

### Custom shape

A shape designed for your API: `code`, `message`, `field`, `details`. Best when the audience is internal or partner, and consumers prefer one consistent shape they can build typed bindings against.

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Account 4d5b has balance 12.40, requested debit 25.00",
    "field": "amount",
    "request_id": "req_9a8c7b"
  }
}
```

Whatever you pick, three rules:

1. **The shape never changes across endpoints.** Consumers write one error handler, not one per endpoint.
2. **Always include a stable error code, not just a message.** Messages change with translations and refinements; codes are forever.
3. **Always include a request ID.** For debugging, this is the single most valuable field. Consumers send it to support and you can find the failing request in logs.

## Step 6: design pagination

Two main models:

### Offset pagination (`?page=3&page_size=20`)

Easy to understand, easy to implement, easy to display "page 3 of 47". Fails when:

- The underlying list changes during pagination (items shift between pages, duplicates and skips appear).
- The list is very long (deep offsets are slow in most databases).

Acceptable for short, stable lists. Bad for active feeds.

### Cursor pagination (`?cursor=abc&limit=20`)

Stable across underlying changes, scales to arbitrary depth. The cursor is opaque to the client (server-controlled). Failure modes:

- Cannot jump to "page N" without iterating.
- Cursor format leaks if not opaque; clients become dependent on internal structure.

Default for any list where the underlying data is active. For most modern APIs, cursor is the right call.

The mistake to avoid: offering both and expecting consumers to choose. Pick one; if you have a UI that needs "go to page 47", build that on top of cursor by counting (acceptable for small lists, bad for large ones).

## Step 7: idempotency

Idempotency is the property that calling the same request multiple times has the same effect as calling it once. This matters because network failures cause clients to retry, and retries that aren't idempotent corrupt state.

Two mechanisms:

- **HTTP method semantics.** `GET`, `PUT`, `DELETE` are idempotent by convention. `POST` is not. If you need idempotent creation, prefer `PUT` over `POST`, and let the client choose the ID.
- **Idempotency keys.** Client-generated key (e.g. `Idempotency-Key: <uuid>`) sent with every mutating request. Server stores the key + result; replays return the cached result. Industry-standard for payment APIs.

The decision: do you trust clients to generate unique keys, and do you have the storage for them?

- Internal-only: HTTP method semantics are usually enough.
- Partner / public: idempotency keys for any mutating operation. The cost of a duplicate charge or duplicate notification dwarfs the cost of the key storage.

## Step 8: backwards-compatible change taxonomy

For an existing API, classify every proposed change:

### Safe (additive)

- New endpoint.
- New optional field in request body.
- New field in response body (consumers must ignore unknown fields).
- New optional query parameter.
- New error code value (consumers must handle unknown codes gracefully).

These ship without a version bump.

### Risky (semantic-breaking even if structurally additive)

- Tightening validation on an existing field (was permissive, now strict).
- Changing the semantics of an existing field (e.g. "amount" was cents, now dollars).
- Adding required fields to requests.
- Removing fields from responses (clients may depend on them even if undocumented).
- Changing error codes for existing failure modes.
- Renaming fields, even with backwards-compatible alias.

These need careful change management even if they don't look like breaking changes. Notice period for partners, deprecation flag in docs, monitoring for affected callers.

### Breaking

- Removing endpoints.
- Removing fields from requests.
- Changing field types.
- Reordering positional path parameters.
- Changing authentication mechanisms.

These require a new version. The old version stays alive for a defined deprecation window.

The discipline: state your change taxonomy before you start writing changes, not after consumers complain.

## Step 9: write the contract first

Before writing code, write the contract as a document:

- For REST/HTTP: an OpenAPI / Swagger spec.
- For GraphQL: an SDL schema.
- For gRPC: a proto file.

The contract goes through review before the implementation does. This catches design issues when they're cheap to fix — at the spec level, not after the handler is implemented.

For each endpoint, the spec should show:

- The full request shape (path, query, headers, body).
- The full response shape (status, headers, body) for each documented status code.
- Examples for the typical request and at least one error.
- Auth requirements.

The contract is the source of truth. Generated docs come from it; client SDKs come from it; tests come from it.

## Common anti-patterns

- **Overloading POST with verb-shaped action paths.** `POST /users/{id}/do-the-thing` is fine if the action is genuinely RPC-shaped. `POST /users/{id}/update-email` is not — that's PATCH on the user with the new email field.
- **Returning HTTP 200 with an error field in the body.** Status codes exist for a reason; consumers' middleware depends on them. Use the right status code.
- **Stringly-typed enum values.** `"status": "pending"` is fine until you also accept `"PENDING"` and `"Pending"`. Document the exact set of values and reject others.
- **Inconsistent pluralization.** `/users` vs `/user/{id}` vs `/getUser`. Pick one convention and stick.
- **Verbs in path segments.** `/users/{id}/get` instead of `GET /users/{id}`. The HTTP method IS the verb.
- **Generic 500 errors as the default.** Consumers can't act on 500s. Distinguish client errors (4xx, the consumer can fix) from server errors (5xx, the consumer should retry or escalate).
- **Field that can be either a single value or an array.** Consumers have to write conditional parsing. Always an array, even when it has one element.
- **Returning slightly different shapes for "single resource" vs "list of one resource".** Always return the same shape; lists are lists.

## Output format

When this skill is invoked, produce:

1. **Audience and protocol choice** — who consumes this, which protocol shape (REST/GraphQL/gRPC/hybrid), and why.
2. **Resource model** — the noun set, or the action set if RPC-shaped, with justification.
3. **Versioning approach** — chosen strategy and the rule for what triggers a new version.
4. **Error shape** — RFC 7807 or custom, with the canonical fields and at least two examples.
5. **Pagination model** — cursor or offset, with the cursor format if cursor.
6. **Idempotency story** — which endpoints need it, which mechanism.
7. **Sample endpoints** — three to five representative endpoints with full request/response shapes.
8. **Change-taxonomy notes** — for an existing API, classify the proposed changes.

If the decision is significant enough, recommend writing an ADR to capture it.

## Related skills

- `architecture-decision-records` — capture the protocol/versioning/error-shape decisions so future readers know why.
- `schema-design` — the storage layer the API sits on. The two designs must be consistent.
- `security-review` — review the API design for auth, authz, and input-validation issues before shipping.
- `monitoring-and-alerting` — design the observability for the new endpoints at the same time as the contract.
