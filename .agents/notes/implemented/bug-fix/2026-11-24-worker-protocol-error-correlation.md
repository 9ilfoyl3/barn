# Agent Note: Worker protocol errors fail fast and remain correlated

Status: implemented

## Problem

Host-discovered skill catalogs can grow to many packages. The Worker Session seed carried a catalog revision assembled from every discovered skill ID and preference, so a real 102-skill catalog produced a 5,841-character value. The protocol rejected that `session.open` message because `skillRevision` was capped at 200 characters.

The Worker reported validation failures with the fixed request ID `invalid-host-message`. The Host therefore could not match the error to the open request and waited for the full request timeout, showing users only `Agent Worker request timed out: session.open` and leaving every new Worker session unable to start.

## Decision

The Host treats the skill catalog revision as an opaque bounded cache key and sends a SHA-256 digest instead of serializing the catalog itself. Protocol validation failures preserve the original request ID whenever the malformed envelope contains one, so the Host rejects the corresponding promise immediately with the actual validation error. Messages without a usable request ID still fall back to the diagnostic ID.

## Alternatives considered

**Raise the revision limit.** Rejected because catalog-derived values are naturally unbounded and would eventually hit another limit while wasting IPC payload size.

**Increase the request timeout.** Rejected because validation errors are immediate and deterministic; waiting longer only hides the cause and blocks the user.

**Let the Host validate every outgoing message.** Rejected as the sole fix because the Worker remains the trust boundary and may run a different protocol version, so it must still return correlated validation errors.

## Consequences

- A large local skill catalog no longer prevents Worker sessions from opening.
- Catalog changes still invalidate open Worker sessions because the bounded digest changes with discovery, enablement, or custom-skill state.
- Malformed Worker requests fail immediately with their validation message instead of timing out.
- Valid request payloads and normal Worker request correlation are unchanged.
