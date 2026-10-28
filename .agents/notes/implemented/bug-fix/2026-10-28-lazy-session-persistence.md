# Agent Note: New Sessions persist only after the first prompt

Status: implemented

## Problem

New session previously created a Session database row immediately. Repeated clicks produced empty history entries, and even a single abandoned draft wrote encrypted persistence state before the user sent a message.

## Decision

New session is a Renderer-only draft identified by a client-generated UUID. Clicking it resets the conversation view and performs no Session IPC. Attachment selection uses the draft UUID as its managed directory name but still creates no Session row. On the first send, the Renderer creates the Session with that UUID and calls `AgentService.prompt`; `ensureSession()` keeps prompt handling idempotent. Only Sessions with at least one event are returned by `listSessions()`.

Session live events are subscribed once and routed through an active-Session-ID ref. This lets the draft become live before React has propagated the new active ID to effects.

The duplicate-empty cleanup and hidden-history rule are recorded in [Empty Session rows stay out of history](2026-10-28-single-empty-session.md).

## Alternatives considered

**Persist immediately and hide empty Sessions from the sidebar.** Rejected because abandoned drafts would still write Session rows and require later cleanup.

**Persist when files are attached.** Rejected because selecting a file is not sending a message and would recreate the empty-history problem before send.

**Keep the draft in the main process.** Rejected because a draft has no durable state; a Renderer UUID is sufficient for attachments and lets the first prompt create the row with its stable identity.

## Consequences

- New session and repeated New session clicks write no Session database row.
- Attachments have a stable destination before the Session exists.
- A Session appears in Recent only after the first prompt is accepted.
- Attachment files from discarded drafts can remain orphaned in the workspace and are outside the Session database cleanup boundary.
