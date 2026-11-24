# Agent Note: WeCom Mail support is removed

Status: implemented

## Problem

The WeCom Mail connector was an optional remote MCP integration with its own credential flow, transport implementation, capability mapping, UI branding, and tests. Product direction no longer includes enterprise WeChat mail support, so keeping the integration would retain code and credential surface without a supported use case.

## Decision

Barn no longer ships the `wecomMail` connector definition, adapter, registration, UI branding, translations, or tests. Startup removes any persisted `wecomMail` connector record and its encrypted connector credentials so upgraded installations do not fail while resolving a connector kind with no definition.

The previous design remains recorded in [WeCom Mail uses the official MCP endpoint](2026-11-23-wecom-mail-mcp-connector.md) as history. Other connectors and the generic connector approval, action, and argument-schema boundaries are unchanged.

## Alternatives considered

**Keep the adapter but hide the connector from the catalog.** Rejected because it preserves dead remote-transport and credential-handling code, plus stale records that could still be addressed through lower-level APIs.

**Leave stored WeCom records in place.** Rejected because connector listing requires a matching definition and would fail for the unsupported kind.

**Migrate the stored API key into another integration.** Rejected because there is no supported replacement destination and credentials must not be repurposed.

## Consequences

- The Plugins page lists only Email, GitHub, and DingTalk.
- Existing WeCom connector records and encrypted credentials are deleted on the next startup.
- WeCom capability ids can no longer be discovered or called.
- The generic connector infrastructure remains available for supported connectors.
