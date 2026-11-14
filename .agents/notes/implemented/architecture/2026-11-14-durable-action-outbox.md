# Agent Note: Consequential actions execute through a durable outbox

Status: implemented

## Problem

A permission approval answers whether an action may happen, but not how to execute it without duplicate sends, lost retries, or ambiguous crash recovery. Calling an external API directly from a model tool would make approval, execution, retry, and audit separate and unreliable lifecycles.

## Decision

Desktop stores every consequential action as a durable Action with a stable idempotency key, encrypted payload, permission kind, optional Task and Approval links, execution status, attempt count, retry time, encrypted error, encrypted result, and timestamps.

`ActionService` evaluates the permission policy before creating executable work. `allow` queues the Action immediately, `deny` records a cancelled Action with the reason, and `ask` creates a pending Action linked to a durable Approval. Approval resolution events move approved Actions to `queued` and cancel denied Actions.

Execution uses registered `ActionHandler` adapters. The dispatcher claims one queued Action at a time, increments its attempt count, invokes the handler with the stable idempotency key, enforces a timeout, and records success or a retry/failure outcome. Running Actions are returned to the queue on restart. Retry delays use bounded exponential backoff, and terminal failures can be retried explicitly.

Every lifecycle transition is appended to the Action audit trail. Payloads, summaries, details, errors, results, and audit event data are encrypted with the Desktop session cipher.

## Alternatives considered

**Execute external writes directly from tools after approval.** Rejected because retries and process restarts can duplicate the external effect.

**Keep the pending queue in memory only.** Rejected because closing the app would lose work or leave an external operation in an unknown state.

**Treat the idempotency key as optional.** Rejected because deduplication must be mandatory for retry safety.

**Let ActionService own provider-specific credentials and API calls.** Rejected. Adapters receive one Action and return a result; credential and provider policy stay in composed application code.

## Consequences

- Approval and execution remain separate but linked, durable states.
- Duplicate enqueue attempts return the original Action by idempotency key.
- Handler implementations must honor the idempotency key and should treat a duplicate call as the same logical external effect.
- The outbox is at-least-once infrastructure; true exactly-once behavior depends on the external provider's idempotency support.
- No production external adapter is registered in this module. Email, calendar, and messaging adapters can be added without changing the outbox contract.
