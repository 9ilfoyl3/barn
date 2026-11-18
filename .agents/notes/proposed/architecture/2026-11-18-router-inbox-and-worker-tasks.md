# Agent Note: Router inbox and worker task execution for sessionless interaction

Status: proposed

## Problem

Barn already has a durable Principal Thread and durable Tasks, but the interaction path is still Session-shaped:

- The renderer decides whether a message is a direct answer or a Task.
- Sending a message blocks the composer while one active Session is running.
- A user cannot add another message until the current model response finishes.
- The active Session transcript is still treated as the execution and display path.
- Task execution creates Sessions internally, but a Task result is not modeled as an explicit visible event anchored to the originating request.
- Browser work previously replaced the home layout with an Agent Screen. That coupling is removed, but the runtime ownership problem remains.

The target behavior is different: the user can send messages at any time; the Router processes accepted requests in order; the Router either replies itself or delegates durable Tasks to Workers; and the visible Assistant Thread remains continuous without exposing Sessions.

## Proposal

### Core concepts

Introduce six explicit concepts:

- **Router**: one logical coordinator per Principal Thread. It owns request interpretation, sequencing, clarification, direct replies, Task creation, and Task updates.
- **Inbound Request**: one durable user message accepted into the Router inbox. It exists before any model call and survives restart.
- **Router Turn**: one leased attempt to process an Inbound Request. Router Turns are serialized per Principal Thread.
- **Task**: durable delegated work with an internal Task Contract and a user-visible lifecycle.
- **Worker Run**: one bounded execution attempt for a Task. A Worker Run owns one internal Work Session.
- **Visible Event**: an explicitly committed Principal Thread event such as a user message, Router reply, Task card update, or Task result.

Sessions remain execution resources only. They never define navigation, ownership, or visible history.

### Request admission

`router.submit` replaces `sessions.prompt` as the default interactive entry point.

In one SQLite transaction, the Main process must:

1. append the user message to the Principal Thread;
2. insert the Inbound Request in `queued` state;
3. assign the next per-thread sequence;
4. persist attachment descriptors, source refs, and an idempotency key;
5. return the durable message and queue position to the renderer.

The renderer must acknowledge acceptance, not wait for a model result. The composer remains enabled while Router or Worker work is active.

### Router state machine

Each Inbound Request moves through:

```text
received -> queued -> routing -> completed
                            -> failed
                            -> cancelled
                            -> superseded
```

Rules:

- One Router Turn may be `routing` for a Principal Thread at a time.
- Router Turns are FIFO by admission sequence unless an explicit user action promotes priority.
- A later user message does not cancel an earlier accepted message implicitly.
- A later message may explicitly revise an earlier Task through an `update_task` decision. The relationship is recorded, not inferred from timing alone.
- Every transition is durable before the next external effect.

A Router Turn returns one of these structured decisions:

- `reply`: project a committed assistant message to the Principal Thread.
- `clarify`: ask one focused question and keep the request open for the user's answer.
- `create_task`: create a Task and submit it to the Worker scheduler.
- `update_task`: append instructions or constraints to an existing Task.
- `answer_task`: resolve a Task question or approval boundary.
- `cancel_task`: cancel an existing Task with an explicit reason.

The first implementation can reuse the existing deterministic delegation policy behind this decision contract. A model-backed Router may improve judgement later, but its output must validate against the same schema.

### Router context

The Router receives a bounded context assembled by the Main process:

- current Inbound Request and attachments;
- recent Principal Thread messages needed for conversational continuity;
- summaries and status of active Tasks;
- confirmed memory items with provenance;
- explicit source references and working-directory scope;
- user approvals and policy constraints.

The Router does not receive the full Worker transcript. It receives Worker status and result summaries. This keeps routing context small and prevents one Task's tool output from corrupting unrelated decisions.

### Worker execution

A Task enters the existing Task scheduler only after the Router has committed:

- objective;
- deliverable;
- constraints;
- input and source refs;
- acceptance criteria;
- forbidden actions;
- risk and execution lane.

The scheduler may run multiple Workers in parallel, but each Task has exactly one responsible Worker at a time. A Worker Run receives an isolated Work Session and returns a structured result envelope:

- Task ID and Worker Run ID;
- outcome: `completed`, `needs_input`, `needs_review`, `failed`, or `cancelled`;
- result summary;
- artifact refs;
- evidence and verification refs;
- unresolved limitations;
- external-effect receipts.

A Worker cannot append arbitrary text directly to the Principal Thread. The Main process validates the result envelope and projects the appropriate Visible Event.

### Visible Thread projection

Every visible assistant event must name its causal anchor:

- Router reply: `inboundRequestId`;
- clarification: `inboundRequestId`;
- Task started: `inboundRequestId` and `taskId`;
- Task result: `taskId` and the originating `inboundRequestId`;
- Task needs input or approval: `taskId` and `inboundRequestId`.

The Principal Thread may therefore show:

```text
user: Research this vendor
user: Also compare support terms
user: And don't contact them yet
assistant: I've queued both requests. Research starts first; I'll apply the support-terms comparison when it reaches that request.
task: Vendor research is running
task: Support-terms comparison is queued
task: Vendor research needs review
```

Results may complete out of order, but causal anchors prevent them from being attributed to the wrong request.

### Persistence

Add Main-owned tables:

- `router_inbox`: request identity, thread sequence, message ID, state, priority, attempt count, lease owner, lease expiry, timestamps, failure code.
- `router_turns`: request ID, attempt, decision kind, decision payload, task ID, reply message ID, model usage, timestamps.
- `task_runs`: task ID, execution attempt, work-session ID, state, result envelope, receipt refs, timestamps.
- `visible_events`: Principal Thread message ID, event kind, causal refs, source refs, payload hash.

All writes remain behind the existing Main-process single-writer services. Renderer IPC exposes commands and snapshots, never database access.

### Concurrency and ordering

- Router lane: concurrency 1 per Principal Thread.
- Worker lane: configurable concurrency, starting with a small bounded default.
- Interactive direct replies and background Tasks use separate scheduler lanes so a long Task cannot starve routing.
- Queue ordering is durable. UI ordering uses the Principal Thread sequence, while Task cards sort by task state and update time.
- Live model deltas remain transient activity. Only committed replies and results enter durable history.

### Recovery

- On startup, expired `routing` leases return to `queued` with a new attempt number.
- Accepted user messages are never deleted during recovery.
- A Task Worker Run that may have started an external effect is marked `unknown_effect` unless an idempotent receipt proves the outcome.
- Unknown external effects are surfaced to the user; they are never replayed automatically.
- Duplicate result envelopes are ignored by `task_run_id`.
- Cancellation is durable and checked at every Router and Worker boundary.

### User experience

The home remains one persistent three-column workspace:

- **Routines**: recurring or scheduled work and app connections.
- **Assistant Thread**: all accepted user messages, Router replies, and Task outcomes.
- **Tasks**: active, waiting, and recent Task cards.

Composer behavior:

- always enabled while the model is working;
- each accepted message receives a compact queue state;
- the end of the Thread shows a bounded queue summary such as `2 messages queued`;
- clicking a queued message can cancel it or promote it;
- no Agent Screen, no Session picker, no New Session control, and no hidden background conversation.

Thread behavior:

- the user's message appears immediately after durable acceptance;
- Router replies may appear later and remain anchored to their request;
- Task activity is rendered as progress and result blocks, not raw model thinking.

### Comma design reference

The parts worth adopting from Comma are conceptual, not implementation-specific:

- one coordinator per work scope;
- Tasks, not conversations, are the persistent unit of delegated work;
- Workers use bounded independent Sessions;
- visible messages are explicit writes, not automatic projections of raw model output;
- Task lifecycle has one authority;
- a Task has one responsible Worker at a time;
- accepted work survives process failure;
- human review is tied to the reviewed result version.

Barn should not initially copy Comma's full swarm, provider, or BEAM/OTP machinery. The minimum useful model is one serial Router plus a bounded Worker pool over the existing SQLite and Electron Main process.

## Alternatives considered

**Client-side send queue only.** Rejected because messages would still be lost or reordered after a renderer crash, and routing would remain renderer-owned.

**Keep one long-lived model Session and queue prompts into it.** Rejected because Task contexts would continue to contaminate one another and long-running Tasks would stall interactive conversation.

**Start every user message as a Task.** Rejected because direct questions, clarifications, and conversational replies need lower latency and do not need durable execution contracts.

**Process Router Turns in parallel.** Rejected for the first version because concurrent turns can make contradictory Task decisions from the same conversational prefix. Serial routing is simpler to reason about and test.

**Allow Workers to write directly to the Principal Thread.** Rejected because untrusted tool output and partial model text would bypass validation, ordering, and visible-message contracts.

**Reuse the Agent Screen as the Worker status surface.** Rejected because it hides the home layout and exposes Runtime rather than Task state. Worker progress belongs in Task cards and Thread result blocks.

## Acceptance criteria

- A user can submit three messages while the Router is still processing the first; all three appear immediately and survive restart.
- The Router processes accepted requests FIFO and records one durable decision per request.
- The composer is not disabled by Router or Worker activity.
- A direct Router reply and a delegated Task result are both projected with a valid causal anchor.
- A Task has at most one active responsible Worker and one current Worker Run.
- Restarting during routing does not lose accepted messages or duplicate external effects.
- Task completion is derived from a validated Worker result, not from Router prose.
- A Task that needs review does not become completed until the required review is recorded.
- Cancelling a queued request, running Router Turn, or Task is reflected in the Thread and Task rail.
- The default UI never exposes Session IDs, Session lists, New Session, Side Chat, or Agent Screen.
- The Routines / Assistant Thread / Tasks three-column home remains visible during all browser and Worker activity.
- A restart preserves the queue, Principal Thread order, Task state, and pending decisions.
- Routing-evaluation coverage includes direct reply, clarification, Task creation, Task update, cancellation, and ambiguous multi-message sequences.

## Risks

- Serial Router processing can feel slow under bursty input; queue status and later priority handling must make waiting understandable.
- A model-backed Router may produce valid but incorrect task boundaries; deterministic policy fallbacks and a golden evaluation set are required.
- Out-of-order Task results can confuse users without strong causal anchors and compact progress rendering.
- SQLite write contention can become visible with a large Worker pool; Worker concurrency must remain bounded.
- A canonical Router context can grow without a compaction policy; use bounded context assembly and durable summaries rather than an infinite transcript.
- Background Tasks can starve interactive routing unless separate lanes and admission limits are enforced.
- Cancellation races can create orphaned Workers; every Worker Run needs a durable cancellation boundary and receipt.
- Local-first operation does not yet define cross-device handoff semantics; that remains a separate architecture decision.
