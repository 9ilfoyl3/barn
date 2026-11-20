# Agent Note: Router uses a native structured decision tool

Status: implemented

## Problem

Barn asked the model to print a JSON decision as ordinary assistant text and then parsed it with `JSON.parse`. A normal conversational answer, markdown wrapper, long reply containing formatting, or malformed model-generated JSON therefore failed the entire request even though the model's intent was clear. This is a fragile protocol difference from Comma, whose Router submits native tool calls that the runtime validates and dispatches.

## Decision

The Router exposes one native tool, `route_decision`, whose schema names the allowed actions and carries a validated argument object. Each model attempt receives this tool plus `toolChoice: auto`. A completed native tool call is validated with the existing Zod decision union before any Task or reply is written.

If the provider does not emit a native tool call, Barn accepts a text response only when it is a complete valid decision object. The first invalid response triggers exactly one repair request containing a bounded description of the schema mismatch and the previous output. A second invalid response fails closed.

The Router tool uses preferred JSON-schema constrained sampling where a provider supports it. Tool output is still validated locally, so provider-side constraint claims are not trusted as authorization.

## Alternatives considered

**Keep prompting for JSON text.** Rejected because ordinary models frequently answer in prose and long natural-language replies make raw JSON brittle.

**Accept any plain text as a direct reply.** Rejected because a malformed task or reminder decision would silently become an answer.

**Retry forever or rely on model self-repair.** Rejected because it increases latency and can loop. One repair attempt matches the useful part of Comma's invalid-tool-argument recovery without hiding repeated contract failures.

**Trust constrained sampling without local validation.** Rejected because provider support differs and the Router decision has security and state-transition consequences.

## Consequences

- Direct questions such as a clothing recommendation should arrive as a validated `reply` tool call rather than a free-form JSON response.
- Providers without native tool support retain a strict JSON compatibility path.
- One malformed model response can recover without user intervention.
- A second malformed response produces the durable visible Router error added in the previous fix.
- The repair prompt contains bounded error details but does not persist the full raw model response.
