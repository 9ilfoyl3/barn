# Agent Note: Desktop lifecycle proposals require explicit Renderer approval

Status: implemented

## Problem

The Agent needs to propose lifecycle transitions, but giving it a lifecycle write or approval tool would let model output change employee state without a human decision. The Renderer also must not receive Cloud access tokens or call the HR API directly.

## Decision

The Agent Worker receives one lifecycle capability, `lifecycle_propose_transition`. The Host executes it through the typed `HrClient`, which calls the Cloud proposal endpoint. This tool creates only a pending proposal and returns a result that explicitly says no lifecycle state has changed.

When the proposal tool succeeds, `AgentService` emits a typed `lifecycle.proposal` Session live event. The Renderer opens a modal showing employee, from/to state, effective date, reason, and the employee version used by the proposal. The modal supports Reject and Approve actions through trusted `hr:*` IPC.

The Renderer reuses one idempotency key per displayed proposal across retries. The Host calls the Cloud decision endpoint; Cloud rechecks the employee version and lifecycle state and commits atomically. After a successful decision, the Renderer clears the modal, invalidates the current tenant read cache, refreshes the employee list, and refreshes an open employee detail if it refers to the same employee.

The Agent has no approve, reject, lifecycle commit, or generic employee write tool.

## Alternatives considered

**Let the Agent approve its own proposal.** Rejected because proposal generation is not human approval.

**Render the approval form in a browser page.** Rejected because lifecycle decisions belong inside the authenticated Desktop Host/Renderer boundary and do not need a second web flow.

**Expose access tokens to the Renderer so it can call the decision API directly.** Rejected because the Host remains the credential and Cloud request boundary.

**Persist approval drafts in Session history.** Rejected because the proposal is Cloud state and must remain authoritative across devices. The current modal is transient; a later lifecycle case list can reopen pending proposals.

## Consequences

- the Agent can prepare a transition but cannot apply it;
- approving or rejecting remains a user action backed by Cloud version checks;
- retries reuse the same idempotency key while the same proposal stays open;
- closing the modal does not reject or cancel the Cloud proposal;
- the Renderer confirms immediate commits and scheduled future transitions with distinct status notices;
- Workspace exposes a Lifecycle tab backed by Cloud cases/tasks, can update task status and assignee, and can reopen a pending proposal after the transient event modal was closed;
- the header notification center polls while open, lists worker-delivered in-app notifications, and marks them read;
- notification delivery remains Cloud follow-up work.
