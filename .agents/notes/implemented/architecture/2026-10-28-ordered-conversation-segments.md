# Agent Note: Conversation parts follow event order

Status: implemented

## Problem

Rendering thinking, tools, and assistant text in separate fixed regions hides the order in which the model reasoned and acted. A run that thinks, invokes a tool, thinks again, then answers appeared as one block of thinking followed by one block of tools followed by all text. Live SSE events and replayed Session events also used different data shapes, so the layout could jump when a run completed.

## Decision

A conversation message owns one ordered `ConversationPart[]` sequence. Live events append or update parts in arrival order: thinking deltas extend the current thinking part, text deltas extend the current text part, and tool lifecycle events insert and update tool parts at their chronological position. Persisted assistant message content is replayed in the same order, with tool-result events updating the matching tool part in place.

The renderer maps this sequence directly, so live and final conversation turns use the same layout and segment identity. Tool-start events carry serialized arguments so a live tool card has the same useful context before persistence completes.

## Alternatives considered

**Keep separate thinking, tool, and content fields and sort during render.** Rejected because the fields discard ordering across repeated alternations and require synthetic timestamps or heuristics.

**Render each assistant message as its own card.** Rejected because a single agent turn can contain several assistant/tool-result messages; it would fragment one response into unrelated bubbles.

**Store every delta as a Session event.** Rejected because ordered complete assistant messages and tool results are sufficient for replay, while delta persistence adds encryption and write volume.

## Consequences

- Thinking, tools, and content can alternate any number of times within one assistant turn.
- Live and persisted output share one rendering model.
- Tool-result correlation requires stable tool call IDs.
- New conversation part types must define both replay and live-event update behavior.
