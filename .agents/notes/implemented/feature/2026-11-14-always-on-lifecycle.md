# Agent Note: Barn remains resident and resumes work after sleep or reconnect

Status: implemented

## Problem

An always-on personal Agent cannot stop when its main window closes or when the laptop sleeps. At the same time, background residency must not become noisy or impossible to quit.

## Decision

Barn keeps the Electron process resident after the main window closes. The window close action hides it; the app becomes visible again through the tray, the macOS app activation event, or a second launch. Quit is explicit from the tray and sets an `isQuitting` guard so the window can close normally.

A template-aware tray icon is packaged on macOS and Windows. Its menu opens Barn, opens Needs you, toggles launch at login where the OS supports it, and quits.

On system resume, unlock, and an offline-to-online transition, Barn nudges the Task runner and immediately polls local sources and the Action outbox. Normal background intervals remain responsible for steady-state progress.

System notifications are limited to Tasks entering `proposed`, `waiting`, or `failed`. They are suppressed while a window is focused and deduplicated per Task update. Clicking a notification opens the Needs you view.

## Alternatives considered

**Quit on window close.** Rejected because it contradicts local always-on behavior and stops proactive work.

**Keep the main window always visible.** Rejected because the Agent should stay available without occupying the desktop.

**Notify on every task event.** Rejected because progress, assignment, and routine state changes do not require human attention.

**Poll sleep/network state through a model.** Rejected because this is deterministic operating-system lifecycle work.

## Consequences

- The app remains available for local sources and background Tasks.
- Close and quit now have intentionally different meanings.
- Launch at login is opt-in and platform-gated.
- Wake and reconnect events accelerate recovery without replacing service-level retries.
- Notification clicks route directly to the attention inbox.
- Tray lifecycle behavior requires platform packaging and E2E coverage.
