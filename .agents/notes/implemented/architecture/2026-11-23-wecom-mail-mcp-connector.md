# Agent Note: WeCom Mail uses the official MCP endpoint

Status: implemented

## Problem

WeCom Mail exposes search, read, and send through the member-authorized smart-robot MCP server. Barn needed to support that official endpoint without adding provider-specific Worker tools, exposing the endpoint API key to the model, or bypassing approval for sends. The console can provide either a bare `apikey` or a complete Streamable HTTP URL, and the key expires and must be reauthorized by a member.

## Decision

The built-in `wecomMail` connector accepts one encrypted credential containing either the bare API key or the full Streamable HTTP endpoint. A bare key is expanded to the official `https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=...` endpoint; full URLs are accepted only when they use HTTPS, the `qyapi.weixin.qq.com` host, an `/mcp/` path, and a non-empty `apikey` parameter. The credential remains in the existing encrypted connector credential store.

The Host implements the bounded Streamable HTTP MCP handshake: initialize, notifications/initialized, tools/list, and tools/call with JSON-RPC IDs, MCP session IDs, protocol-version headers, cookies, bounded timeouts, and cancellation. The connector maps three stable Barn capabilities:

- `wecomMail.search` to `mail_search` as a read capability;
- `wecomMail.get` to `mail_get` as a read capability;
- `wecomMail.send` to `mail_send` as an external write.

Reads use the existing external-read permission path. Sends use the existing Action Outbox and approval path; the MCP adapter is called only after approval and action claim. Tool argument objects are passed through to the official server because WeCom owns their evolving JSON Schemas. The model receives only connector metadata and capability ids, never the endpoint URL or API key.

## Alternatives considered

**Add dedicated WeCom mail tools to the Worker schema.** Rejected because provider tools would grow the Worker prompt and could bypass the stable connector discovery, permission, and Action Outbox boundary.

**Accept arbitrary remote MCP URLs.** Rejected because a stored connector could become an SSRF and credential-exfiltration surface. The endpoint is constrained to WeCom's official MCP host.

**Store the endpoint or API key as ordinary connector configuration.** Rejected because the URL embeds the API key. Both forms remain encrypted credential data and never reach Renderer snapshots.

**Execute `mail_send` immediately from the model loop.** Rejected because external writes need durable approval, retry, cancellation, unknown-effect handling, and duplicate suppression through the Action Outbox.

## Consequences

- Members can connect with either the console API key or the complete endpoint URL.
- Reauthorization is required when the WeCom key or authorization link expires.
- Tool availability still depends on the robot's granted WeCom Mail permissions; a missing `mail_send` is reported as an MCP tool error at call time.
- MCP sends have no universal exactly-once guarantee. The Action Outbox remains at-least-once and may surface `unknown_effect` after ambiguous failures.
- The Streamable HTTP transport is currently scoped to the WeCom Mail connector; other remote MCP providers still need their own reviewed host/authentication policy.
