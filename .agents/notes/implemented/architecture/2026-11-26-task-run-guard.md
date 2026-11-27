# Agent Note: Durable Task runs use an outer guard for silent work

Status: implemented

## Problem

A Task was durable, but its execution attempt was not. `TaskRunner` kept active ownership only in memory and could react to explicit `run.status` failure or cancellation. If the process stayed alive while a model or tool stopped making progress, the Task could remain `running` indefinitely. A restart recovered Tasks to `queued`, but there was no durable attempt record, heartbeat, lease, or idempotent guard decision.

The DSH article describes an outside Watchdog even though the published prototype does not contain one. Salix supplies the concrete operational pattern: watch only active delegated work, wait for a grace period, send at most one reminder per delegation epoch, notify on a later stop, and recover decisions from durable records after restart.

## Decision

Schema 14 adds `task_runs`. Each launch creates a durable execution attempt linked to one Task and Session, with an attempt number, lease owner/expiry, heartbeat, last-progress time, status, encrypted error, and guard state (`watching`, `nudged`, `escalated`).

`TaskRunner` owns run transitions during normal execution. Every live event for the run refreshes its heartbeat and progress time. Completion, failure, cancellation, approval waits, requeues, and process interruption settle the attempt through the run store. A host restart closes running attempts and returns their Tasks to the queue through the existing recovery path.

`TaskGuardService` is the deterministic outer watchdog. It checks active running Tasks on an interval and:

- pauses a Task whose run record is missing, whose worker ownership disappeared, or whose attempt is already terminal;
- waits for a configurable silent interval without progress;
- performs at most one guard nudge per attempt;
- pauses the Task after a further grace interval with no progress;
- closes orphaned running attempts when their Task ended elsewhere.

The Worker protocol cannot accept a second prompt while a turn is running. A guard nudge therefore stops the silent attempt and starts a new attempt in the same Session with a bounded status request. The new run inherits the guard sequence so the next silence can escalate rather than nudge forever. After grace, the guard cancels the worker and moves the Task to `waiting / input` with a plain explanation. It never records success or a business failure on the Task's behalf.

`TaskRunner` also ranks due work as person Task, reminder, then automation, and reserves one worker slot for due person work when automation would otherwise occupy every slot. The guard never preempts an already running automation Task; reservation affects admission only.

## Alternatives considered

**Treat process health as Task health.** Rejected because the process can be alive while the model loops, a tool hangs, or no result is ever published.

**Use a model as the first watchdog.** Deferred because a model check adds cost, latency, and another non-deterministic failure point. Deterministic silence and ownership checks establish the durable frame first; semantic direction review can use the same run state later.

**Mark a silent Task failed.** Rejected because lack of progress is not proof that the work cannot be resumed. `waiting / input` preserves the Task, Session, result references, and person-controlled recovery.

**Keep guard state only in memory.** Rejected because restart would repeat nudges and lose the difference between the first and second stop. Run attempt and guard state are durable.

**Interrupt the Worker with a second prompt.** Rejected because the Worker runtime rejects concurrent prompts. A same-Session attempt restart is the supported equivalent and remains visible in the run history.

## Consequences

- Every Task execution attempt is auditable and survives restart.
- A stuck Task becomes `waiting / input` and appears in Needs you instead of sitting in progress forever.
- Guard nudges restart the same Session, preserving context, at the cost of one additional model turn when a task is silent.
- Defaults are conservative: 30-second checks, 10 minutes of silence before a nudge, and 5 minutes of grace before pausing. Environment variables can tighten them for tests or operators.
- A guard pause is not completion, failure, or approval. A person can add instructions and run the Task again.
- Semantic "wrong direction" auditing remains future work; the current guard covers ownership, liveness, progress, and convergence to a human decision.

Related: [Durable Task domain](2026-11-14-durable-task-domain.md), [Background Task execution](2026-11-14-background-task-execution.md), [Connected app sources](../feature/2026-11-26-proactive-connector-sources.md).
