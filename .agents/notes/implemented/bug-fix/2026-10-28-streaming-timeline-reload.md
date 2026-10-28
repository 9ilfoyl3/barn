# Agent Note: Complete messages do not trigger live timeline reloads

Status: implemented

## Problem

The Worker persists complete assistant and tool-result messages while a run is still active. The Host previously emitted a `session.updated` event for every persisted message. The renderer treated each update as a request to reload the full encrypted timeline, leaving the transient live turn mounted at the same time. During a multi-step tool run, the same assistant turn therefore appeared twice: once from the persisted timeline and once from the SSE-style delta stream.

## Decision

Persisting a complete streamed message no longer emits `session.updated`. The prompt-start update publishes the user message and running summary, and the terminal `run.status` update publishes the final session summary. The renderer reloads durable messages at prompt start and when the run reaches a terminal state; transient deltas remain the only source for the active assistant turn.

Running status events do not emit another `session.updated` because prompt start already announced the running state.

## Alternatives considered

**Reload and deduplicate in the renderer.** Rejected because the transient live turn and persisted assistant messages have no shared stable identity in the current event shape. A merge heuristic would still race with in-flight deltas.

**Persist every delta.** Rejected because it increases encrypted write volume and turns provider-specific frames into replay state.

**Disable timeline reload until the run ends.** Rejected because the user message would not appear immediately unless the renderer maintained a separate optimistic session store.

## Consequences

- Active assistant output has one rendering source: transient live events.
- Durable assistant and tool messages appear once when the run reaches a terminal state.
- Sidebar timestamps and statuses update at prompt start and run completion rather than after every persisted message.
- Any future renderer consumer of `session.updated` must not assume it fires for every message append.
