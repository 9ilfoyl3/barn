# Agent Note: Router failures are visible conversation events

Status: implemented

## Problem

A Router request moved to `failed` when the model returned an invalid structured decision or could not be reached. The waiting orbs disappeared with the terminal Router status, but nothing was appended to the Principal Thread. The user saw a completed thinking animation followed by no answer and no explanation.

## Decision

Every Router failure now appends one durable assistant error message to the Principal Thread before the request is marked failed. The message uses plain-language guidance, records `routerError` and a bounded error detail in metadata, and stores its id on the failed Router request.

At startup, Desktop backfills a visible error for recent failed Router requests that do not have a reply message. This repairs the historical state created before the fix without deleting or replaying the original request.

The Renderer refreshes and merges the Principal Thread when a Router request reaches a terminal state, closing the event/snapshot race where orbs could stop before the committed message appeared.

## Alternatives considered

**Keep only the Router request error in SQLite.** Rejected because the request queue is an implementation surface and the person needs an explanation in the conversation they were already reading.

**Treat invalid model text as a direct reply.** Rejected because it can silently turn a task request into an answer and hides model-contract failures.

**Show only a global error banner.** Rejected because a transient banner is not anchored to the request and disappears from history.

**Delete failed requests during startup.** Rejected because failures are useful audit evidence and the user message must remain intact.

## Consequences

- Invalid Router output now results in a visible, durable error tied to the originating request.
- The failed request has a `replyMessageId` pointing to the visible error message.
- Historical failed requests are repaired once during Router startup.
- Terminal Router events trigger a bounded thread snapshot merge in the Renderer.
- A retry action remains a future improvement; the current UX asks the user to resend or clarify.
