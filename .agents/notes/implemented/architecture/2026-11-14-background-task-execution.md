# Agent Note: Queued tasks execute through a single recovery-safe runner

Status: implemented

## Problem

A durable Task without an execution owner remains only a record. The Desktop needs a background path that creates or reuses a Session, starts Agent work without blocking the renderer, projects completion and failure back into the Task, and behaves predictably after cancellation or process restart.

## Decision

`TaskRunner` starts queued Tasks through AgentService and keeps one Task active per configured slot, with a default concurrency of one. A task without a prompt moves to `waiting` for input rather than invoking the model with an empty request. Before invoking the model, the runner creates or reuses a Session, links it to the Task, and transitions the Task to `running`.

The runner subscribes to Session live events. A completed Agent turn marks the Task `completed`; a failed or cancelled run marks it `failed` or `cancelled`; a Worker crash marks the active Task failed instead of leaving it running forever. Task changes are serialized through the same Task service used by IPC. Cancelling a Task asks AgentService to cancel its Session.

Task instructions are encrypted with the Desktop session cipher before storage. Databases created by the task-domain foundation are migrated in place with prompt ciphertext columns. Restart recovery returns interrupted running Tasks to `queued` and detaches their prior Session so the next launch does not append the same instruction to a partially executed transcript. Later action-outbox work remains responsible for preventing duplicate external side effects across restarts.

## Alternatives considered

**Run every task on the renderer thread.** Rejected because work would stop when the window closes and would couple task lifecycle to UI rendering.

**Create a new Session for every retry.** Rejected because an intentional retry should be able to continue its prior transcript. Only crash recovery detaches the interrupted Session.

**Allow unlimited concurrent task launches.** Rejected for the first implementation because local compute, provider limits, and user attention are finite. One slot is predictable; the option remains injectable for tests and later settings.

**Store prompts as plain Task metadata.** Rejected because task instructions can contain sensitive office data. Prompt text uses the same authenticated encryption boundary as Session events.

## Consequences

- Queued Tasks automatically run after creation or restart when instructions are available.
- Task state follows Agent run outcome without renderer involvement.
- Worker crashes and model-start failures become visible Task failures.
- Restart recovery avoids duplicate prompts inside one Session, but external side-effect idempotency is deferred to the action outbox module.
- Task titles, lifecycle details, and failure messages remain SQLite metadata; task instructions are encrypted.
