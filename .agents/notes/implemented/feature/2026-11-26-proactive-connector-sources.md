# Agent Note: Connected app watches are automatic for GitHub and conversational for DingTalk

Status: implemented

## Problem

Barn could call GitHub and DingTalk on demand, but a connector could not watch a scoped source over time. An explicit event-source settings page also forced users to translate “watch this repository or group for this purpose” into connector IDs, targets, event kinds, polling intervals, and automation modes. That is implementation language, not the user's intent.

The product needs two different defaults:

- GitHub should begin observing the connected user's repositories, pull requests, and issues after the account is connected;
- DingTalk must stay quiet by default because conversation observation is more sensitive;
- a person should start a DingTalk or narrower GitHub watch by asking the Router in ordinary language, including whether Barn should analyze the match or prepare a reply.

## Decision

`ConnectorSourceStore` remains the durable internal source/event pool. Source configuration, cursor state, errors, and event summaries are authenticated-encrypted. Events are unique by `(source_id, event_key)` and keep a matter key, URL, occurrence time, and linked Task id. There is no user-facing connector event-source configuration page.

On each connector source pass, `ConnectorSourceService` ensures one `github-default` watch for every ready GitHub connector. That watch has `bound-user` scope, observes open issues and pull requests across up to 20 repositories returned for the connected account, and uses `observe` mode by default. It records a baseline on first read. It needs no settings flow and follows new repositories on later reads.

DingTalk has no default watch. The Router exposes three validated tools:

- `watch_create`: provider, optional connector, natural-language target, actors, keywords, purpose (`analysis` or `reply`), and the user's instruction;
- `watch_list`: active watches in user terms;
- `watch_cancel`: stop by id, name, or DingTalk target label.

A Router-created watch is active: a matching item becomes a queued Task. Analysis watches ask the Worker for a recommendation or next step. Reply watches ask the Worker to prepare the reply through the approval-backed external-write path; the collector itself remains read-only and never sends as the user.

For GitHub, Router targets accept `owner/repository` or a GitHub URL and optional author logins. “My repositories” resolves to the default bound-user watch. For DingTalk, an explicit `cid_…` or `user:<id>` is used directly; otherwise `dingtalk.chatSearch` and `dingtalk.contactSearch` resolve one target. Ambiguous or unresolved targets produce a clarification request rather than an invented identifier.

The existing automation settings remain the fallback mode for sources without a per-watch mode. First collection is always a baseline. Later versions use the existing event deduplication, matter grouping, Task creation, TaskRun, guard, approval, Action outbox, Needs You, and result delivery paths.

## Alternatives considered

**Keep the event-source settings page.** Rejected because it exposes transport details and duplicates intent already present in the conversation. Router tools are a smaller, goal-level surface.

**Watch every DingTalk conversation by default.** Rejected because DingTalk content is private and noisy. A person must explicitly name the conversation or person and the matching purpose.

**Create one giant GitHub bound-user source with unbounded repositories.** Rejected. Discovery is capped at 20 repositories per pass so a large account cannot create an unbounded burst of API calls and Tasks.

**Create a Task just to configure a watch.** Rejected. Watch configuration is a small bounded host mutation; the watch itself creates future Tasks only when a matching event arrives.

**Auto-send replies from a reply watch.** Rejected. A reply watch prepares the response, but the existing approval/outbox boundary remains authoritative for external writes.

**Run all Router-created watches in observe mode.** Rejected because the user explicitly asked Barn to analyze or reply. The resulting Task is queued, while any external side effect still waits for approval.

## Consequences

- GitHub observation starts automatically with a connected account and needs no UI.
- DingTalk remains silent until the user asks the Router to watch a specific target.
- Natural-language watchers preserve the user's instruction, target label, keywords, purpose, and per-watch mode.
- Source creation and watch management are auditable in the same encrypted source/event store.
- Users can list or cancel watches conversationally without seeing connector implementation details.
- A first read establishes a baseline; only later changes create suggestions or queued work.
- The collector is polling and read-only. Webhook/stream ingestion and model-based semantic drift auditing remain future work.

Related: [Proactive automation defaults to observe mode with attention budgets](2026-11-14-proactive-observe-mode.md), [Local file and schedule events become proposed Tasks](2026-11-14-local-event-sources.md), [Durable Task runs use an outer guard for silent work](../architecture/2026-11-26-task-run-guard.md).
