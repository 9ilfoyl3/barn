# Agent Note: Connector effects appear in the Needs you inbox

Status: implemented

## Problem

Connector writes entered the durable Action Outbox and could create Approval records, but the Task Center only rendered Task records. A connector approval therefore had no general-purpose surface outside the browser-specific approval prompt. Recent connector action status and failures were also invisible after the Send action returned.

## Decision

ConnectorService exposes a bounded, payload-free summary of recent `connector.effect` Actions. The Renderer receives only id, title, summary, details, status, attempts, error, and timestamps; it never receives the encrypted Action payload.

The Task Center accepts general pending Approvals and renders connector approvals alongside Task attention. Browser approvals remain on their existing browser-specific surface and are filtered out of the Task Center. Approving or denying a connector Approval resolves the durable Approval record; the Task Center then refreshes recent connector action status. Recent non-pending connector actions show queued, running, sent, failed, or dismissed state and their failure reason.

## Alternatives considered

**Create a synthetic Task for every connector action.** Rejected because an Action is an execution effect, not necessarily user-delegated work, and a synthetic Task would duplicate lifecycle authority.

**Show connector actions only in Connector settings.** Rejected because a pending external effect needs attention in the same inbox the person already checks.

**Expose raw Action records to the Renderer.** Rejected because Action payloads may contain email bodies, recipients, or connector arguments. The summary projection is sufficient for approval and audit display.

**Poll all Actions continuously from the Renderer through IPC events.** Rejected for this slice. The existing bridge is locally bounded and the Task Center refreshes while open; a general Action event stream can replace polling later.

## Consequences

- Connector sends are visible and actionable in the Task Center.
- A denied connector approval cancels the Action and appears as a dismissed recent action.
- Browser approvals are not duplicated in the Task Center.
- The Task Center polls recent connector actions every three seconds while mounted.
- Approved writes still follow the Action Outbox and provider idempotency limits.
