# Agent Note: Router executes ordinary work through one stable call envelope

Status: implemented

## Problem

The previous Router could make only one connector lookup in a turn. A normal request such as reading a DingTalk conversation requires contact resolution followed by message retrieval, so the Router had to create a durable Task even though the work was ordinary, synchronous, and short-lived. That made the Worker the default executor for ordinary office work and produced visible Task/Worker startup failures for work the front-door agent could finish itself.

The DingTalk process runner also waited only for the child-process `close` event. A successful CLI request could finish while an inherited stdio handle kept `close` pending, causing a false 30-second "DingTalk operation timed out" after the API had already returned success.

## Decision

The Router uses the same architectural pattern as Comma: one stable native `call` envelope for business tools, with the callable catalog disclosed in the system prompt. `route_decision` remains the only final-action tool.

The host discloses ordinary synchronous tools backed by `ToolService`: file read/write/edit and search, image viewing, memory, skills, connector discovery, and connector calls. The Router may execute up to eight sequential tool calls across up to ten model rounds, with a bounded aggregate output budget. Connector calls keep ConnectorService permissions and the Action Outbox boundary. The native tool schema does not change with connector count or capability count.

The Router is now the default executor for ordinary work. A durable Task is reserved for isolation from the front-door conversation, background or out-of-turn execution, monitoring and waiting, long-running browser or shell work, parallel workstreams, substantial code/config changes, or deliverables that must survive the turn. Multiple tool calls or connector reads do not by themselves justify a Task.

Shell and browser tools remain Worker-only. Their execution can be long-running or requires an isolated Task context, while the ordinary Router catalog covers synchronous office work.

The DingTalk process runner resolves on process `exit` after waiting a short bounded grace period for stdout/stderr to drain. `close` still resolves immediately when it arrives. The original operation timeout remains the hard stop for a process that has not exited.

## Alternatives considered

**Raise the connector-read cap from one to two.** Rejected because it fixes only the DingTalk example and leaves every other multi-step ordinary request classified as a Task.

**Expose every business tool as a separate native Router tool.** Rejected because it makes the native schema depend on connector count and capability configuration, increasing prompt churn and duplicating the host tool catalog.

**Let the Router expose shell and browser directly.** Rejected because those are the operations most likely to need isolation, continuation, or background execution, which is the remaining purpose of the Worker.

**Wait only for child `close`.** Rejected because inherited stdio handles can outlive the actual CLI process. Waiting only for `exit` without a drain grace was also rejected because large output can still be buffered when the process exits.

## Consequences

- A contact lookup followed by a message read completes in one Router turn without a Task.
- Ordinary file writes and edits can complete synchronously in the Router.
- The Router remains bounded by call, round, and output budgets.
- Connector writes still obey permission and Action Outbox behavior.
- Browser, shell, monitoring, parallel research, and other durable or isolation-sensitive work still use the Worker.
- DingTalk CLI success no longer turns into a false timeout when a descendant keeps a stdio pipe open.
