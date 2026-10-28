# Agent Note: Agent reasoning runs in a Worker behind Host-owned capabilities

Status: implemented

## Problem

A Codex-like local Agent needs multi-turn reasoning, model access, filesystem inspection, and shell execution without exposing provider credentials or unrestricted operating-system capabilities to model-driven code.

## Decision

Electron starts a dedicated utility-process Agent Worker. The Worker runs Pi Agent Core, executes the multi-turn tool loop, and persists complete messages through the Electron Host. It has no provider credentials, database handle, or direct filesystem access.

The Host owns model streaming, SQLite session storage, sandbox policy, file tools, and shell execution. Worker requests and Host responses use a Zod-validated discriminated protocol. Tool calls are narrow and typed; the Worker calls Host capabilities rather than spawning processes directly.

The chat renderer receives only typed session events. Live text deltas are transient. The Host persists the display user message plus structured attachment metadata and injects local attachment paths only when rebuilding model context; the Worker persists complete assistant and tool-result messages. All of these records are encrypted Session events.

## Alternatives considered

**Run the Agent in the renderer.** Rejected because the renderer is sandboxed and must not gain filesystem, shell, or credential capabilities.

**Run the Agent directly in the Electron main process.** Rejected because a long-running model loop or crash would share the main-process lifecycle and make cancellation and isolation weaker.

**Give the Worker direct filesystem and shell access.** Rejected because credentials and OS-level authority would move outside the Host boundary.

**Store every streamed delta in SQLite.** Rejected because it adds high write volume without improving replay; only complete messages are durable.

## Consequences

- Worker crashes reject outstanding Host requests and abort provider streams;
- the Host is the security boundary for credentials and local capabilities;
- protocol changes require coordinated Host and Worker updates;
- session replay depends on persisted complete messages rather than provider-specific transient frames.
