# Agent Screen and Browser Use Implementation Plan

> **For agent:** Execute modules sequentially. Every module branches from `develop`, ships with unit/integration coverage plus real Electron e2e, and merges only after the full relevant verification suite passes.

**Goal:** Build a local-first agent workspace with a real built-in browser surface, a visible Agent Screen, and a shared typed capability boundary that can later add VM and Computer Use providers.

**Architecture:** The Electron Host owns the built-in browser through an isolated `WebContentsView` session. The renderer only receives typed state and lays out a right-side split. A shared Agent Screen surface hides while the browser panel is open and returns when it closes.

**Tech Stack:** Electron 45, React 19, TypeScript, Playwright Electron e2e, Vitest, Pi Agent Core.

---

## Module 1: Browser Surface Split

**Branch:** `feat/browser-surface-split`

**Scope**
- Add typed `BrowserBridge` contracts and trusted IPC.
- Create an isolated `WebContentsView` browser session.
- Add URL navigation, back/forward/reload, loading/title state.
- Add a top-right Browser button.
- Add a right-side sliding split with a renderer chrome and native browser content.
- Add an Agent Screen placeholder that is hidden while Browser is open and visible when closed.
- Add browser capture for the collapsed Agent Screen preview.

**Acceptance**
- Browser button opens and closes the split.
- Browser loads a local HTTP fixture.
- URL bar, title, loading state, and navigation state stay synchronized.
- Browser native view follows panel bounds during resize.
- Agent Screen is hidden while Browser is open and visible after close.
- `pnpm typecheck`, `pnpm lint`, unit tests, security check, and focused Playwright e2e pass.

## Module 2: Agent Screen Live Card

**Branch:** `feat/agent-screen-live`

**Scope**
- Vendor the MIT Agents Kit Agent Screen presentation source with attribution.
- Replace the placeholder with the real component.
- Display live browser capture, connection state, current URL, and action steps.
- Add expand/collapse and manual refresh.
- Redact sensitive query values in visible preview metadata.

## Module 3: Browser Semantic Control

**Branch:** `feat/browser-semantic-control`

**Scope**
- Add typed browser snapshot and action tools.
- Use Accessibility Tree and CDP-backed actions rather than screenshots.
- Support click, type, select, press, scroll, waits, and tabs.
- Persist tool actions into the Session timeline.

## Module 4: Browser Security and Artifacts

**Branch:** `feat/browser-security-artifacts`

**Scope**
- URL/origin policy, permission denial by default, popup handling.
- Managed downloads/uploads.
- Approval integration for external side effects.
- Browser diagnostics and security tests.

## Module 5: Provider Boundary

**Branch:** `feat/agent-computer-provider`

**Scope**
- Introduce provider-neutral Agent Computer interface.
- Keep built-in browser as the lightweight default provider.
- Prepare optional Secure VM and host Computer Use providers without bundling a VM image.
