# Agent Note: Consequential actions use durable approvals outside model control

Status: implemented

## Problem

Natural-language instructions are untrusted input. A local Agent that can eventually send messages, modify files, or perform destructive operations cannot rely on the model to decide whether an action has user permission. The decision must survive restarts, be visible to the person, and remain auditable.

## Decision

Desktop stores a four-part safety policy: local read, workspace write, external write, and destructive actions. Each part is `allow`, `ask`, or `deny`. The default allows local reads and workspace writes, and requires approval for external writes and destructive actions.

Permission evaluation happens in the Electron main process. `allow` returns immediately, `deny` fails closed, and `ask` creates a durable Approval with the requested action, a human-readable summary, optional details, and an optional Task link. Approval summaries and details are encrypted with the Desktop session cipher. When an Approval is linked to a Task, the Task enters `waiting` with `waitingReason: approval` and stores the Approval id.

Only the trusted Desktop surface can resolve an Approval. Approval transitions from `pending` to `approved` or `denied` exactly once and records `resolvedAt`. A `denied` Task is cancelled; an `approved` Task returns to the queue. Model output, task instructions, and external content cannot call the resolution path as a person.

The Task Center shows approval requests through the existing Task waiting state. Approve resolves the durable Approval and resumes the Task; Dismiss denies it and ends the Task.

## Alternatives considered

**Keep permission rules only in system prompts.** Rejected because prompt text cannot provide a bypass-resistant boundary or durable audit.

**Ask the model whether an action is safe.** Rejected because the model is the component requesting the action. It cannot also be the approver.

**Keep approvals only in memory.** Rejected because app restart or a sleeping device would erase the person's pending decision.

**Start with a large settings surface.** Rejected because the defaults cover the safe common path. The typed policy bridge and persistence are ready for progressive disclosure later.

## Consequences

- External writes and destructive actions default to requiring a person.
- Approval decisions survive restart and remain queryable.
- Task state and approval state stay linked without making the renderer the source of truth.
- Enforcement at each future external-write tool is still required; the policy engine alone does not magically stop a tool that does not call it.
- The action outbox module remains responsible for binding an approval to one idempotent external action.
