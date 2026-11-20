# Agent Note: Tasks have one Worker and durable contracts/results

Status: implemented

## Problem

Task reruns created a second per-task Router Session and ran it beside the Worker. The Router Session had tools, so a single Task had two concurrent executors. The Task Contract also existed only as JSON inside the execution prompt, and completion used the Worker's final prose without a durable result envelope. Follow-up messages also lacked a host-owned rule for deciding whether the Router or the Worker should answer.

## Decision

A Task has one responsible execution Session at a time. The global Router decides and updates Task state; rerouting cancels the active Worker, updates the durable Task Contract, and starts a new Worker run with the same Task Session only when the instruction belongs to that Task. No per-task Router Session is created.

Messages sent inside a Task are appended once and serialized per Task. Before any model runs, a Task Router decision with no execution tools chooses exactly one authority: `worker.dispatch`, `router.reply`, or `task.cancel`. Worker and Router therefore never answer the same follow-up in parallel. The Router may answer status, failure explanation, review, approval, memory, or other coordination questions from bounded Task context, but it cannot execute Task work. An actionable or ambiguous request goes to the Worker. Invalid Router output or a Router call failure falls back to the Worker without dropping the user message.

The TaskRunner writes each validated Result Envelope into the Task Session as Router-readable coordination context before projecting the result to the Principal Thread. The Worker remains the only source of completion evidence and external effects.

Task Contracts are normalized and encrypted in the Task row. Task results use a typed Result Envelope with outcome, summary, artifacts, evidence refs, limitations, and external-effect receipts. A Worker run completes a Task only when it produced a final assistant answer; the TaskRunner records a Result Envelope before projecting the result into the Principal Thread. Missing answers and Worker failures record failed envelopes rather than claiming completion.

Principal-Thread Router decisions fail closed when the model returns unstructured text or invalid JSON. The Principal Router does not reinterpret malformed output as a direct reply. A Task Router coordination failure is different: the Host falls back to Worker delivery so a Task instruction is not lost.

## Alternatives considered

**Keep the parallel Router and Worker and copy the Router reply into the Worker Session.** Rejected because both Sessions can execute tools and write side effects, and completion ordering depends on whichever role is pending.

**Let the Router use the normal Agent tool loop for Task follow-ups.** Rejected because task coordination would again become a second executor. The coordinator receives one structured decision tool and no filesystem, shell, browser, connector, or other work tools.

**Always send Task follow-ups to the Worker without a Router gate.** Rejected because status, failure, approval, and review questions would be executed as fresh work and could produce duplicate or misleading answers.

**Persist the Contract only in the Worker prompt.** Rejected because acceptance criteria, forbidden actions, risk, and source refs must be queryable and enforceable by Host code.

**Treat any Worker text as completion evidence.** Rejected because prose is not a structured result and may omit failures, artifacts, or limitations.

**Fallback to a direct reply when Router JSON is malformed.** Rejected because it silently converts a potentially delegated request into a conversational answer.

## Consequences

- Task detail briefly shows Router coordination before a Worker starts; only one authority answers each Task message.
- Router-only Task replies remain in the Task transcript and never enter the Principal Thread.
- If Task Router coordination is unavailable, message delivery degrades to Worker execution instead of failing.
- Contracts and results are encrypted at rest and survive restart outside the Session transcript.
- Rerouting appends the new instruction to the Contract constraints and clears the previous result.
- `needs_review` Tasks return to the Needs you queue with a review waiting reason.
- Worker output is still summarized from the final assistant message until a dedicated structured-result tool exists; the Result Envelope improves durability and evidence refs but does not yet prove acceptance criteria.
