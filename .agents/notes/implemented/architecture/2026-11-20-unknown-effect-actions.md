# Agent Note: Interrupted external effects become unknown_effect

Status: implemented

## Problem

ActionService returned every `running` Action to `queued` on restart. For connector writes such as email or DingTalk sends, the process may have started the external request before crashing, so replay can duplicate a message. The old recovery behavior treated an unknown outcome as a safe retry.

## Decision

Restart recovery changes a claimed `running` Action to `unknown_effect` and appends an audit event with a person-readable explanation. It does not queue the Action automatically. The Connector inbox shows the unknown state with explicit Retry and Dismiss actions.

Explicit Retry moves the Action back to `queued` with its existing stable idempotency key. Dismiss cancels the Action without claiming that the external effect did not happen. The durable audit trail retains the original started and unknown-effect events.

## Alternatives considered

**Automatically retry every running Action.** Rejected because provider-side idempotency is not guaranteed, especially for DingTalk robots.

**Mark every interrupted Action failed.** Rejected because failure would falsely imply the provider did not accept the request.

**Try to infer the outcome from provider APIs automatically.** Deferred. Provider-specific reconciliation can add a receipt lookup, but not every connector exposes one.

## Consequences

- A crash can stop progress until a person checks the provider and chooses Retry or Dismiss.
- Duplicate sends are no longer caused by blind restart replay.
- The stable idempotency key remains available for providers that support it.
- Unknown-effect resolution records the person's decision in the Action audit trail.
