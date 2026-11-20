# Agent Note: Connector capabilities are host-owned and email uses IMAP/SMTP

Status: implemented

## Problem

Barn's Agent tools were a fixed local catalog. Adding an office application required editing the Worker schema, Host dispatch, permission checks, and tests together. That made secrets easy to expose to the model, made connector availability invisible to the Router, and left no stable boundary between read capabilities and approval-backed external writes.

## Decision

Desktop stores connector instances in the encrypted Session database and stores credentials in a separate file encrypted through the existing OS-backed secret codec. The renderer receives connector status and non-secret configuration only.

The Worker exposes two stable connector tools:

- `connector_list` returns connector definitions, configured instances, status, and capability ids;
- `connector_call` invokes one validated capability.

Read capabilities require the `external-read` permission and execute immediately when allowed. External-write capabilities enter the Action Outbox as `connector.effect`; a registered action handler executes only after the normal approval policy and claim lifecycle. The outbox supplies the stable idempotency key to the adapter.

The built-in email connector uses IMAP for bounded listing, search, and message reads, and SMTP for sending. Configuration contains mailbox endpoints and addresses; usernames, passwords, and app passwords remain credential-only. Messages and attachments are represented as untrusted external data.

The Router receives a bounded projection of configured connectors and their capability ids so it can delegate connector work without receiving credentials or connector evidence.

## Alternatives considered

**Put each connector operation directly into the Worker tool schema.** Rejected because the schema would grow with every account and provider, prompt prefixes would churn, and the model could infer capabilities that were not configured for the current user.

**Store connector credentials in SQLite with the instance configuration.** Rejected because credentials have a stricter lifecycle than configuration and should use the OS credential encryption seam already used by model providers.

**Let connector writes execute directly after a model call.** Rejected because approval, retry, process restart, and duplicate suppression belong to the durable Action Outbox, not the model loop.

**Start with OAuth-only email.** Rejected for the first slice because it would exclude ordinary IMAP/SMTP accounts and require provider-specific app registration. App passwords and provider-specific OAuth can share the same credential-reference boundary later.

## Consequences

- Adding a connector implementation no longer requires adding a new Worker tool.
- Connector credentials never enter prompts, Renderer snapshots, or connector list results.
- External reads are a distinct permission class; external writes use the existing approval and Outbox path.
- Email operations are bounded by message count, body size, and operation timeout.
- SMTP has no universal exactly-once guarantee. The Action Outbox remains at-least-once and providers may still duplicate a send when an ambiguous failure occurs.
- Dedicated OAuth, connector health checks, and inbound email triggers remain future work.
