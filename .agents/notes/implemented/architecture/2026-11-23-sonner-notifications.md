# Agent Note: Status feedback uses one top-center Sonner surface

Status: implemented

## Problem

Success and error feedback appeared as inline banners inside Plugins, Skills, Models, Sources, Diagnostics, Task Center, Task Detail, and the main conversation. Their position and styling changed with the surrounding layout, they pushed content when they appeared, and errors from background actions could be missed below the fold.

## Decision

The renderer mounts one Sonner `Toaster` at the app root. Toasts use the top-center position with a 64px offset below the window search bar, Barn semantic tokens, a close control, and reduced-motion handling.

Operation successes call `notifySuccess`. Operation failures either call `notifyError` directly or keep their existing error state and route it through `useErrorToast`, which emits one toast whenever the error changes. Contextual inline states remain inline when they describe a persistent object rather than an operation result, such as a source's `lastError`, a connector test result, or a form's current loading/empty state.

## Alternatives considered

**Keep inline notices and restyle them.** Rejected because they still displace surrounding content and produce different behavior across dialogs and full-page views.

**Use separate toast renderers per surface.** Rejected because stacking, accessibility, and positioning would diverge between pages, and toasts opened by background actions could be hidden by dialogs.

**Move every error into component local state first.** Rejected because it would require rewriting established error flows; `useErrorToast` preserves the existing state and exposes it consistently without changing retry or recovery behavior.

**Put the Toaster at the very top of the viewport.** Rejected because it overlaps Barn's persistent window search field; the 64px offset places notifications directly below that chrome while keeping them top-center.

## Consequences

- Success and failure feedback is transient, consistent, and independent of the active page layout.
- Sonner owns stacking, dismissal, keyboard access, and screen-reader announcements.
- The old `.settings-notice`, `.settings-error`, and `.error-banner` presentation paths are removed.
- Operators can still find object-specific failures where they belong, such as per-source and per-connector status.
- Future actions should call the shared notification helpers rather than adding a new inline status banner.
