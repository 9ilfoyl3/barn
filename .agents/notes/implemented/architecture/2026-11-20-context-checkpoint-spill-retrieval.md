# Agent Note: Context checkpoints retain refs and history is retrievable

Status: implemented

## Problem

Context compaction replaced dropped turns with a count-only checkpoint. The full transcript remained in SQLite, but the Worker had no tool that could read it, so omitted facts, decisions, tool errors, and evidence were effectively lost. Long values were truncated from the tail only, which also made incomplete data look complete.

## Decision

Messages loaded into a Worker carry their durable Session sequence and event id. When older turns are compacted, the checkpoint records the exact sequence range and includes bounded extracts of recent user requests, assistant conclusions, tool names, and tool failures. The checkpoint explicitly states that it is lossy and tells the model to retrieve omitted details.

The Worker receives a `session_history` Host tool. It can read only its own Session and supports sequence ranges, role filtering, a text query, a bounded result count, and a total character budget. Returned messages are truncated from the middle with an instruction to request a narrower range when more detail is needed.

Value truncation now preserves both the beginning and end of user messages, assistant text, and tool results. The middle marker explains how to retrieve the full content through `session_history`.

## Alternatives considered

**Put the entire transcript back into context after compaction.** Rejected because it defeats the context budget and makes the model spend attention on unrelated history.

**Keep the count-only checkpoint and rely on memory search.** Rejected because memory is a separate durable layer and does not contain arbitrary Session evidence or tool output.

**Truncate only the beginning or only the end.** Rejected because both the original request and the latest conclusion can matter, and a one-sided cut makes the remaining text look complete.

**Expose all Sessions to the retrieval tool.** Rejected. The tool requires the active execution Session id and cannot accept a session id from the model.

**Generate a model-written summary during compaction immediately.** A semantic summary remains future work; this change first fixes the safety boundary by preserving references and making every spill retrievable.

## Consequences

- Compaction remains extractive, but omitted history is recoverable.
- `session_history` reads are bounded to the current Session and cannot cross privacy boundaries.
- Sequence metadata tags are ignored by model-provider conversion but available to the local context manager.
- Very large histories may require multiple narrow retrieval calls.
- A future compaction v2 can replace extractive highlights with a validated model summary plus the same watermark and retrieval contract.
