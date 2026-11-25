# Agent Note: Router performs bounded read-only work and active Task follow-ups skip coordination

Status: implemented

## Problem

The Router could only classify a message and delegate work. Any request that mentioned a connector became a new durable Task even when it was a simple inventory question or one targeted read-only lookup. The Task contract also required the model to invent deliverables and acceptance criteria before execution. Active Task follow-ups made a second model call to the Task Router before the Worker could continue, so ordinary corrections accumulated routing delay and repeated intent interpretation.

## Decision

The Router is a bounded tool loop, not only a one-shot classifier. It receives a small `call` envelope with two runtime-owned operations:

- `connector.list` returns connector definitions and configured instances without secrets.
- `connector.read` executes only a capability whose definition has `risk: "read"`.

A Router turn allows connector discovery and at most one read-only connector lookup. The model must finish with one validated `route_decision`; connector data can support a direct reply, or the final decision can create a durable Task when the work needs more execution. The Router never receives a write-capable connector path.

Prompts are composed from stable role-first sections in `src/shared/agent-prompts.ts`: identity, shared runtime rules, role responsibilities, Task collaboration, delivery, tool disclosure, skill index where applicable, and channel/language constraints. The Worker receives the names of its actually materialized tools, and its bounded Skill Index is included in the same system prompt with an explicit untrusted-metadata boundary. User-authored custom system instructions are intentionally out of scope. A Task is delivered as a readable brief rather than raw contract JSON.

`task.create` now requires only a title and objective. The host supplies safe defaults for deliverable, constraints, acceptance criteria, risk, execution lane, and expected artifacts. The model no longer has to fabricate planning fields for ordinary work.

For an active Task in `queued` or `running`, an ordinary follow-up is appended once and dispatched directly to the existing Worker. Explicit cancellation phrases are handled by the host without a model call. The Task Router remains for terminal or waiting Tasks and coordination questions where reply versus resume is ambiguous.

## Alternatives considered

**Keep creating a Task for every connector request.** Rejected because connector inventory and one bounded read are safe, immediate operations that do not need durable execution or a separate Worker session.

**Give the Router the existing write-capable `connector_call` tool.** Rejected because external writes must stay behind Task/Action approval boundaries and must not become model-controlled direct actions.

**Expose every connector capability as a native Router tool.** Rejected because it grows the stable tool prefix and duplicates connector contracts. The Router discovers definitions through one envelope instead.

**Keep the Task Router model on every active follow-up.** Rejected because the Worker already owns an active Task and can receive corrections directly. A second model should be reserved for actual coordination ambiguity.

**Keep mandatory detailed Task contracts.** Rejected because requiring invented acceptance criteria and artifacts makes simple work look like a planning exercise and adds latency without improving execution quality.

## Consequences

- Connector inventory and simple read-only data questions can complete in the Router turn without creating a Task.
- Multi-step, background, browser, shell, file-producing, monitoring, and external-write work still becomes a durable Task.
- Direct Router connector writes are impossible; `ConnectorService.callRead` rejects non-read capabilities.
- Active Task corrections resume the same Worker session without a Task Router model invocation.
- Terminal or waiting Task messages still use the Task Router for status, approval, review, or resume decisions.
- Host-owned Task defaults reduce contract size but may be less specific than model-authored criteria for complex work; explicit constraints and artifacts remain accepted when the model has them.
