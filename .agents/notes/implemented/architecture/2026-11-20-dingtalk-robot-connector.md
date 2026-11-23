# Agent Note: DingTalk group robots use the connector effect boundary

Status: implemented

> Superseded by [DingTalk uses a user-authorized local connector](2026-11-23-dingtalk-workspace-user-connector.md).

## Problem

DingTalk is a common office messaging surface, but a webhook URL contains an access token and a robot may require a signing secret or a security keyword. Treating those values as normal prompt configuration would expose credentials and let the model send messages without an approval boundary.

## Decision

The DingTalk connector is a built-in connector definition with a single `dingtalk.send` external-write capability. The Robot webhook URL and optional signing secret live only in the OS-encrypted connector credential store. The optional keyword lives in encrypted connector configuration and is appended when a message does not already contain it.

Messages are sent as DingTalk `text` or `markdown` payloads. When a signing secret exists, Desktop appends the documented timestamp and HMAC-SHA256 signature to the webhook URL. Webhooks must use HTTPS and a `robot/send` endpoint. The request is bounded by a timeout and includes the Action Outbox idempotency key as a header.

Sending uses the existing `connector.effect` Action Outbox path, so the user's external-write policy and approval apply before the adapter is called. The Connector settings page tests the robot only when the user explicitly presses Test.

## Alternatives considered

**Store the webhook URL in the connector configuration shown to the Renderer.** Rejected because the URL embeds the robot access token. Only status and non-secret metadata reach the Renderer.

**Expose a direct `dingtalk_send` Worker tool.** Rejected because per-provider tools would make the Worker schema grow and could bypass the stable connector discovery and Action Outbox boundary.

**Require an organization app and inbound event subscription first.** Rejected for the first slice because a group robot delivers useful outbound value without a hosted control plane. Inbound DingTalk events need a separate trigger design.

**Retry sends without an idempotency signal.** Rejected. The Action Outbox remains at-least-once because DingTalk robots expose no exactly-once response protocol; the idempotency key is retained for future provider-side deduplication and diagnostics.

## Consequences

- Users can connect multiple DingTalk group robots and pause, test, or remove each one.
- Webhook and signing credentials never enter prompts or Renderer snapshots.
- Sending requires the normal external-write approval path unless policy explicitly allows it.
- A lost response can still produce an unknown send outcome; future work must surface unknown effects rather than claiming success.
- Inbound DingTalk messages, app-level OAuth, and directory lookup remain future work.
