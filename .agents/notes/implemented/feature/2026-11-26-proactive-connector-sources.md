# Agent Note: Connected app sources turn connector changes into durable suggestions

Status: implemented

## Problem

Barn could call GitHub and DingTalk on demand, and local folder or schedule sources could create proposed Tasks, but a connector could not watch a scoped source over time. A user who connected GitHub or DingTalk still had to ask Barn to look, so new issues, pull requests, messages, and todos could not reach the observe-first automation path.

Reusing the local source table directly was insufficient. Connector sources need an account reference, provider-specific scope, a durable read cursor, encrypted source state, provider event identity, and a matter key that lets a later change continue the same Task instead of creating another.

## Decision

`ConnectorSourceStore` owns connector-backed source definitions and events in the existing SQLite database. Source configuration, cursor state, errors, and event summaries are authenticated-encrypted. Events are unique by `(source_id, event_key)` and keep a `matter_key`, optional URL, occurrence time, and linked Task id.

`ConnectorSourceService` reads configured sources through the existing read-only ConnectorService capabilities. GitHub observes selected issues and pull requests. DingTalk observes a configured conversation or user, keyword-filtered messages, and open todos. The first successful read records a baseline and creates no Tasks. Later new or changed events use the existing automation settings:

- `observe` creates `proposed` Tasks;
- `active` creates `queued` Tasks;
- the pending-suggestion limit and per-source cooldown apply;
- an open Task already representing the same matter receives the new event instead of a duplicate Task.

Connector source Tasks use the existing Task contract, runner, approvals, Action outbox, Needs You inbox, notifications, and result settlement. The collector never exposes a write path; external changes remain behind the Task/approval boundary. The Plugins page exposes a Sources tab where a user can add a scoped source, pause it, remove it, check now, and inspect recent baseline and suggestion events.

The GitHub adapter accepts an alternate API base only for controlled end-to-end fixtures. The real Electron test uses the real connector adapter, Task runner, and SQLite database with a local fixture server, verifies persistence across restart, and inspects the stored source, event, and completed Task rows.

## Alternatives considered

**Poll from the Router prompt on a timer.** Rejected because model-driven polling has no durable cursor, provider identity, baseline, or deterministic deduplication.

**Reuse local source rows without provider metadata.** Rejected because account references, scope, event identity, and matter grouping are materially different from file signatures and schedule cursors.

**Create a Task for every provider item.** Rejected because comments, CI changes, and repeated updates would flood Needs You; the matter key and open-Task lookup keep one active Task per matter.

**Call the connector with write capability from the collector.** Rejected because collection must be read-only. Sending, commenting, and other external effects continue through approvals and the Action outbox.

**Start with webhook ingress for every provider.** Deferred because local-first operation may have no public endpoint. Polling selected scopes establishes the source/event contract first; webhook or stream collectors can feed the same store later.

## Consequences

- Connected app sources are observe-first and use the same attention settings as local sources.
- A first check establishes a baseline; only later changes create suggestions.
- GitHub issue and pull-request updates share one matter, and DingTalk messages and todos have their own durable event identity.
- Source removal deletes its local event history; removing the connector leaves the source visible with a health error until the connector is restored or the source removed.
- Polling remains bounded and scoped. Broad mailbox or all-conversation scanning is intentionally absent.
- Webhook/stream ingestion, model-based urgency ranking, and digest scheduling remain future work on the same event and Task boundary.

Related: [Proactive automation defaults to observe mode with attention budgets](2026-11-14-proactive-observe-mode.md), [Local file and schedule events become proposed Tasks](2026-11-14-local-event-sources.md).
