# Agent Note: model context is compacted separately from persistent history

Status: implemented

## Problem

Long personal-Agent sessions contain many user turns, large file reads, search results, shell output, and repeated tool loops. The full encrypted Session history must remain available, but sending all of it to every model request eventually exceeds the provider context window and increases cost and latency.

## Decision

The Agent Worker applies a context manager before every model request. Token usage is estimated with pi-ai's context estimator. The model budget is derived from the selected model's context window minus an output/safety reserve.

When the estimated context exceeds the budget, the Worker:

- keeps the leading system prompt;
- keeps the most recent complete user turns and their tool calls/results together;
- replaces older turns with a deterministic checkpoint system message;
- removes old thinking payloads;
- truncates old tool, assistant, and fallback user content before dropping the latest request.

Persistent Session history remains complete and encrypted. Compaction affects only the model window. The renderer receives context usage and a compacted flag through the typed event channel.

## Alternatives considered

**Send the full persistent transcript on every request.** Rejected because it eventually overflows model context and scales cost with total session age.

**Summarize all history with another model call.** Rejected for the first implementation because it adds cost, latency, and a second model data path. Deterministic compaction is safer and predictable for local work data.

**Delete old Session events.** Rejected because users need full replay and auditability locally.

**Treat every message independently.** Rejected because tool calls must remain paired with their tool results.

## Consequences

- complete local history and model context have separate lifecycles;
- compaction is deterministic and does not send sensitive history to an extra summarization model;
- the latest request and current tool loop are always preserved;
- very large individual tool results are truncated even inside the retained tail;
- a future model-generated task summary can be added above the deterministic checkpoint if measured quality requires it.
