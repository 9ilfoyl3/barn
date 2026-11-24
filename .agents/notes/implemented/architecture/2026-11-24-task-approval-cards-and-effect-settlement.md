# Agent Note: Task approvals bind to effects and settle through receipts

Status: implemented

## Problem

A Task Worker could request approval for an external effect, report `pending_approval`, and still be recorded as a completed Task. Connector calls carried only a Session id, so the durable Approval had no Task link. The Principal Thread then showed the Worker's result while the main Router had neither the pending Approval nor a trusted way to resolve it. The person saw contradictory facts: the Task result mentioned approval, but the main conversation said no approval existed.

## Decision

Every Task run carries its Task id through Agent prompt projection, Host tool execution, connector and browser permission checks, and the Action outbox. An Approval created by Task work therefore records `taskId`, and the Task enters `waiting / approval` while the person decides.

`PermissionService` records the person's approval or denial but does not own the Task lifecycle. The effect owner settles the Task:

- a synchronous tool approval continues the blocked tool call and lets the Worker publish its report;
- an approval-backed Action emits durable status changes;
- `TaskActionCoordinator` completes a waiting Task only after its Action succeeds, fails terminally, is cancelled, or has an unknown effect;
- successful Actions add an `action:<id>:succeeded` receipt to the Result Envelope;
- undefined or unknown outcomes remain waiting for review instead of claiming completion.

`TaskRunner` persists a pending Result Envelope without changing `waiting / approval` when external work is still pending. It includes already successful Action receipts when the Worker finishes after an allowed effect, and it refuses to mark a Task complete while an effect is `pending_approval`, `queued`, or `running`.

The Principal Thread projects pending and resolved approvals as beUI `ApprovalCard` instances. The card is the trusted decision surface and calls the existing Approval IPC command. The Router receives bounded pending-Approval and Task-result facts so it can explain the state, but model output and natural-language content cannot approve a Task's own request.

## Alternatives considered

**Let the Router resolve approvals from chat text.** Rejected because Task results and other model context are untrusted input. A typed card action keeps authorization outside model control.

**Requeue the Task as soon as approval resolves.** Rejected because the external effect has not finished. The Task would race the Action and could complete on stale Worker prose.

**Mark the Task complete when the Worker says it is pending.** Rejected because prose is not an effect receipt. Completion must be derived from durable approval and Action state.

**Keep approval metadata only in the Task Center.** Rejected because the person already acts in the Principal Thread. A result notice without its actionable approval card is a broken handoff.

## Consequences

- Connector and browser approvals raised inside a Task are visibly linked to that Task.
- A pending external Action prevents false Task completion.
- Approved Actions resume without a second Worker run; their durable receipt completes the waiting Task.
- Denied or terminally failed Actions cancel or fail the Task instead of leaving it waiting forever.
- Browser approvals still block the tool call synchronously but now render in the Principal Thread before the Worker result exists.
- The beUI Approval Card source is isolated under `src/renderer/components/beui/components/agents/approval-card`; Barn supplies durable facts and localized labels.
