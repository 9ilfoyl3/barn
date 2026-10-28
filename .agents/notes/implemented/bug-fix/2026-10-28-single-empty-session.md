# Agent Note: Empty Session rows stay out of history

Status: implemented

## Problem

Earlier builds created a Session row for every New session click, leaving duplicate empty rows in the sidebar and encrypted Session store.

## Decision

`SessionStore.listSessions()` returns only Sessions whose `last_seq` is greater than zero. Initialization collapses duplicate empty rows left by earlier versions. `createSession()` accepts an explicit ID so the lazy first-prompt flow can use its draft UUID without creating a second identity.

The Renderer-side lazy draft decision is recorded in [New Sessions persist only after the first prompt](2026-10-28-lazy-session-persistence.md).

## Alternatives considered

**Keep duplicate rows but hide them in the sidebar.** Rejected because the duplicates would remain as untraceable local state and still leak through the Session API.

**Delete every empty Session during initialization.** Rejected because it would also discard an in-progress first prompt that had created a row but had not appended its first event yet.

## Consequences

- Empty Sessions never appear in Recent, regardless of how they were created.
- Existing duplicate empty Sessions are removed at startup without deleting Sessions that contain events.
- Session APIs still retain the internal row needed by an in-flight first prompt.
