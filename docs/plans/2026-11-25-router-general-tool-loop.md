# Router General Work Loop Implementation Plan

**Goal:** Align Barn's Router/Worker boundary with Comma's architecture and the product expectation that the Router performs ordinary synchronous work directly while Workers handle isolated, durable, background, or otherwise Task-owned execution.

**Architecture:** The Router keeps one stable native `call` envelope, matching Comma's business-tool dispatch model. The host discloses a bounded catalog of ordinary tools through the system prompt. The Router executes those tools sequentially in its own turn across multiple rounds and finishes with `route_decision`. Worker sessions keep the full tool surface but are reserved for durable Tasks. Shell and browser work remain Task-owned because they are long-running or isolation-sensitive.

## Acceptance criteria

- Router can make multiple ordinary tool calls in one turn, including DingTalk contact lookup followed by message reads.
- Router can directly read/write ordinary workspace files, search files, use memory and skills, and call configured connectors.
- Router never receives more than a bounded tool-call and output budget.
- Connector writes still pass through ConnectorService permissions and the Action Outbox.
- Shell, browser, monitoring, parallel research, and work that must survive the turn remain Worker Tasks.
- The `call` native tool exposes one stable schema independent of configured connector counts.
- DingTalk process completion does not hang until the 30-second timeout when the CLI process exits but an inherited stdio pipe remains open.
- Unit tests, typecheck, and focused Electron tests pass.
- A real-model Electron conversation using the current encrypted model configuration answers a multi-step DingTalk request without creating a new Task.

## Implementation

1. Add a host-owned Router tool catalog and executor backed by ToolService.
2. Replace the connector-specific Router gateway with a generic `call` gateway.
3. Allow a bounded multi-call Router loop and convert tool results back to Pi tool-result messages.
4. Update Router and Worker prompts around direct work versus isolated/background Tasks.
5. Harden the DingTalk process runner around `exit` versus `close` and add a regression test.
6. Update live-model coverage and run the configured real model against DingTalk in an isolated copy of credentials and runtime state.
