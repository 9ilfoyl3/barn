# Agent Note: The task center is an attention inbox inside the existing workspace

Status: implemented

## Problem

Background Tasks need a visible home that matches Barn's existing Desktop shell and remains understandable to first-time users. A dashboard of internal state would expose implementation concepts and compete with the existing conversation surface.

## Decision

The sidebar gains a single `Needs you` destination with a count of Tasks needing attention. The workspace renders three flat groups: `Needs you`, `In progress`, and `Recent`. Proposed and waiting Tasks surface first, followed by active work, while completed and dismissed work remains available without dominating the screen.

Each row shows a plain-language title, status, detail, and update time. Actions are limited to what the state supports: run, approve, retry, dismiss, cancel, open the linked Session, or add instructions. A Task without instructions can be given instructions inline and queued from the same row. The renderer subscribes to Task live events so status and grouping update without polling.

Task-center styling is isolated in `src/renderer/task-center.css`, imports the existing Barn tokens, and preserves the current visual system. Hallmark runs against the component and its isolated stylesheet; Electron E2E captures the actual product surface for visual verification.

## Alternatives considered

**Put Tasks in a new modal or separate window.** Rejected because background work should remain part of the same personal assistant, not become a second application.

**Show every Task in one chronological feed.** Rejected because urgency, active work, and history have different attention costs.

**Expose implementation fields such as prompts or Session identifiers in the list.** Rejected for the default view. Instructions appear only when a person must edit them, and Sessions open only through an explicit action.

**Add task-center styles directly to the legacy global stylesheet.** Rejected because Hallmark needs a reviewable component boundary instead of inheriting unrelated historical findings.

## Consequences

- A first-time user can understand which work needs them without learning internal Agent concepts.
- Task status changes are reflected live from the main-process Task service.
- Waiting Tasks with no instructions are actionable instead of dead ends.
- Open Session remains the bridge from background work to the full execution transcript.
- The task center currently groups by status only; richer prioritisation and proactive suggestion ranking remain future work.
