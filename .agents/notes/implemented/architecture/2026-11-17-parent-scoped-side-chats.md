# Agent Note: Parent-scoped side chats

Status: implemented

## Problem

Side chats are temporary questions about the conversation a user is already viewing. Treating them as ordinary top-level Sessions leaks them into history after crashes or restarts, and an isolated transcript cannot answer questions that depend on the parent conversation.

## Decision

Every side chat stores a durable `parentSessionId`. `SessionStore.listSessions()` excludes child Sessions at the database query boundary, so renderer filtering is not the privacy or history boundary. When the Agent prepares a side-chat prompt, it reads the parent Session's persisted Agent messages and appends a bounded transcript inside a clearly delimited parent-context block. Side chats remain separate Agent runs so their temporary turns do not mutate the parent transcript.

Schema version 6 adds the nullable `sessions.parent_session_id` column. The link intentionally does not use a foreign key because a side chat may be opened from a lazy draft parent before that parent's first message creates its row.

## Alternatives considered

- Keep standalone Sessions and filter them in the sidebar by open tab IDs. This failed after restart or rehydration and made presentation state the only boundary.
- Write side-chat turns directly into the parent Session. This polluted the durable conversation and mixed temporary questions with the main task.
- Copy the parent transcript into the child Session at creation. That duplicated sensitive conversation content and quickly became stale.

## Consequences

Side chats can answer from the parent conversation without appearing in recent history. Context is bounded to keep prompt growth predictable, and older parent turns are omitted first. A missing lazy-draft parent produces an empty context rather than blocking the side chat. Existing standalone side chats remain separate until archived or closed; new child Sessions are identified by `parentSessionId`.
