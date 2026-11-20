# Agent Note: Tasks have one Worker and durable contracts/results

Status: implemented

## Problem

Task reruns created a second per-task Router Session and ran it beside the Worker. The Router Session had tools, so a single Task had two concurrent executors. The Task Contract also existed only as JSON inside the execution prompt, and completion used the Worker's final prose without a durable result envelope.

## Decision

A Task has one responsible execution Session at a time. The global Router decides and updates Task state; rerouting cancels the active Worker, updates the durable Task Contract, and starts a new Worker run with the same Task Session only when the instruction belongs to that Task. No per-task Router Session is created.

Task Contracts are normalized and encrypted in the Task row. Task results use a typed Result Envelope with outcome, summary, artifacts, evidence refs, limitations, and external-effect receipts. A Worker run completes a Task only when it produced a final assistant answer; the TaskRunner records a Result Envelope before projecting the result into the Principal Thread. Missing answers and Worker failures record failed envelopes rather than claiming completion.

Router decisions now fail closed when the model returns unstructured text or invalid JSON. The Router does not reinterpret malformed output as a direct reply.

## Alternatives considered

**Keep the parallel Router and Worker and copy the Router reply into the Worker Session.** Rejected because both Sessions can execute tools and write side effects, and completion ordering depends on whichever role is pending.

**Persist the Contract only in the Worker prompt.** Rejected because acceptance criteria, forbidden actions, risk, and source refs must be queryable and enforceable by Host code.

**Treat any Worker text as completion evidence.** Rejected because prose is not a structured result and may omit failures, artifacts, or limitations.

**Fallback to a direct reply when Router JSON is malformed.** Rejected because it silently converts a potentially delegated request into a conversational answer.

## Consequences

- Task detail shows one live Worker instead of parallel Router/Worker activity.
- Contracts and results are encrypted at rest and survive restart outside the Session transcript.
- Rerouting appends the new instruction to the Contract constraints and clears the previous result.
- `needs_review` Tasks return to the Needs you queue with a review waiting reason.
- Worker output is still summarized from the final assistant message until a dedicated structured-result tool exists; the Result Envelope improves durability and evidence refs but does not yet prove acceptance criteria.
