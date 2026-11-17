# Agent Note: Sessionless interaction with bounded execution and evidence-based memory

Status: proposed

## Problem

Barn Desktop currently exposes Sessions as a user-facing concept. A Session is also the model execution context. That coupling makes a sessionless personal Agent difficult to build safely: users would either manage ever-growing Sessions or lose continuity when a new Session is created.

The product target is one persistent Assistant experience where the user does not manage Sessions, while Task execution remains recoverable and long-term memory remains precise and controllable.

## Proposal

Separate five concepts:

- **Principal Thread**: the only user-visible long-lived conversation.
- **Task**: durable work with an explicit contract and lifecycle.
- **Run**: one leased execution attempt for a Task or interactive turn.
- **Execution Session**: a bounded model context used by one Run.
- **Memory Item**: a versioned, source-linked durable fact, preference, decision, or procedure.

The user sees a personal-secretary shell: Today and Routines on the left, one continuous Assistant Thread in the center, and Tasks on the right. There is no Session list, New Session, or Side Chat. Sessions and Run identifiers remain internal implementation details.

Memory writes pass through evidence and quality gates. Task delegation passes through an explicit delegation policy and a structured Task contract. A model's natural-language claim of completion is not sufficient evidence of completion.

## Alternatives considered

**One permanent model Session.** Rejected because it creates unbounded context, interleaves unrelated work, makes recovery and model switching fragile, and makes privacy boundaries harder to enforce.

**New Session per user message with no Principal Thread.** Rejected because continuity would depend on summaries and the user would still perceive fragmented conversations.

**Every request becomes a Task.** Rejected because simple questions need low-latency direct answers and Task overhead would make the product feel bureaucratic.

**Model-only memory extraction and retrieval.** Rejected because precision, correction, deletion, provenance, and privacy require deterministic storage and policy gates, not only embeddings or summaries.

**Immediate multi-Agent swarm.** Rejected because one orchestrator plus bounded Task workers captures most of the value while keeping ownership and recovery tractable. Specialist agents can be introduced after the Task contract and evaluation set are stable.

## Acceptance criteria

- A user can use Barn across restarts without opening or managing a Session.
- Every accepted user message is durable before model dispatch.
- Each Run has one owner and one durable lease.
- A restarted Run resumes only from a known safe boundary; unknown external effects are surfaced instead of replayed.
- Memory retrieval failure never blocks an interactive response.
- Each memory item has scope, provenance, confidence, version, status, and correction history.
- High-risk external actions still require approval and idempotent outbox execution.
- The delegation policy reaches the agreed direct/task/clarify accuracy thresholds on a golden evaluation set.
- No Session list, New Session, or Side Chat is required in the default product flow.
- The default shell follows the personal-secretary layout: Today/Routines, Assistant Thread, and Tasks.
- Global search replaces Session search.

## Risks

- A new Run/Thread model adds migration and UI complexity.
- Memory consolidation can overwrite useful nuance if conflict rules are too aggressive.
- Delegation thresholds can over-ask or under-delegate if tuned without real usage data.
- Background Tasks can starve interactive requests without lane scheduling.
- A local-first app still needs a clear cross-device synchronization decision before claiming cross-device continuity.
