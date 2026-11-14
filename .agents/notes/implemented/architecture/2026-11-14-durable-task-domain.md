# Agent Note: Durable tasks are separate from Sessions

Status: implemented

## Problem

Barn Desktop uses a Session as both the model's context and the user's unit of work. That is sufficient for a single interactive chat turn, but always-on personal work must survive app restarts, multiple runs, cancellation, and waiting for a person. Coupling task lifecycle to a Session would force users back into session management and make recovery ambiguous.

## Decision

Desktop stores a durable Task in the same SQLite database as Sessions. A Task records its title, origin, status, optional Session link, waiting reason, detail, timestamps, and recovery state. Session history remains the execution transcript; a Task is the user-facing unit of work and may outlive or move between Sessions.

Task status transitions are enforced in the persistence layer. Tasks start as `proposed` or `queued`, run through `running` and optional `waiting`, and finish as `completed`, `failed`, or `cancelled`. A process restart returns `running` tasks to `queued` with a recovery detail. Only `proposed` and `queued` tasks can be created. Waiting tasks must name whether they need input or approval.

Task commands are exposed through a typed Task service and IPC bridge. Changes emit task updates for the UI and future background runtime. Tasks may link only to an existing Session, and deleting a Session clears the link without deleting the Task.

## Alternatives considered

**Keep Session as the task unit.** Rejected because restart recovery, multiple execution runs, proactive suggestions, and waiting-for-user state cannot be represented cleanly without overloading Session status.

**Store tasks in a separate database.** Rejected because Task-to-Session links and future atomic run creation need one transaction boundary. A later storage-boundary refactor can rename the database owner without changing the Task contract.

**Let the renderer own task state.** Rejected because background work and crash recovery must continue without a visible window.

**Derive tasks from Session events.** Rejected because a Session may contain several tasks, and a Task may have no Session yet or outlive its current Session.

## Consequences

- Session remains an execution detail while Task becomes the durable work object.
- The Task state machine and IPC inputs are validated at the persistence and process boundaries.
- Running tasks recover predictably after a crash or app restart.
- The current database owner is still named `SessionStore`; separating storage ownership is deferred to a dedicated refactor.
- Task titles and lifecycle metadata are stored as SQLite metadata, while Session event payloads remain encrypted; content encryption for Task metadata remains a future hardening item.
