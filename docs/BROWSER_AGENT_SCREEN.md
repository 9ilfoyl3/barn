# Browser and Agent Screen

Barn Desktop includes a local built-in browser and a visible Agent Screen inside the conversation workspace.

## Current surface

- The top-right Browser button opens a right-side split and temporarily collapses the sidebar for a wider browser surface.
- The browser uses an Electron `WebContentsView` with a dedicated persistent session partition.
- While the browser is open, the Agent Screen collapses. Closing the browser restores the preview only when the current session has a browser operation.
- The Agent Screen is a compact right-side layout column, not an overlay. Its appearance squeezes the conversation list and composer with a shared grid transition.
- The conversation scroll surface extends beneath the transparent Agent Screen gutter so the scrollbar stays at the workspace's far-right edge while content remains clear of the screen card.
- Idle or new sessions do not mount the Agent Screen; manual browser browsing alone does not create an Agent Screen instance.
- The compact surface shows the live page capture without the kit's footer card.
- The Agent Screen is based on the MIT Agents Kit `AgentScreen` source with local attribution and controls.
- The preview is captured from the real browser page, not a generated mock.

## Browser capabilities

- URL navigation, back, forward, reload, title, loading state, and address normalization.
- Multiple tabs: create, select, close, list, and restore after restart.
- A native-looking new-tab page provides a centered search/URL field, focused search suggestions from recent history, and Terminal, Files, and Side chat shortcuts.
- Terminal opens a sandboxed command surface in the shared right-side utility panel. The default current directory is Barn's real local working directory (or the selected Session directory), so `pwd` shows host paths while macOS Seatbelt still restricts writes, reads, and network access.
- Terminal input supports repeated empty Enter prompts, Shift+Enter multiline commands, command history, `cd`, and `clear`.
- Side chat opens independent Agent Sessions in separate utility tabs. Multiple side chats can run at once and are excluded from the main Session list while open.
- Loaded pages use a browser toolbar with navigation, site information, address, bookmark, download, and overflow controls.
- Semantic observation of page text and interactive elements with stable refs, including open Shadow DOM and same-origin iframes.
- Actions: click, type, select, press, hover, scroll, and wait.
- Bounded visible-text extraction.
- Screenshot capture for visual verification.
- File input upload from the authorized workspace.
- Managed downloads with status and reveal-in-folder support.
- Consequential form submissions and downloads pause for an inline approval bar before continuing.
- Popup windows open as Barn browser tabs.
- Persistent cookies and browser profile through the dedicated Electron session partition.

## Agent tools

The Agent Worker can call:

```text
browser_open
browser_observe
browser_act
browser_tab
browser_read
browser_upload
browser_screenshot
```

The Worker never receives raw DevTools access. The Host executes fixed, typed browser operations. File input upload uses Chromium DevTools Protocol internally only after the Host resolves and authorizes the file path.

## Security boundary

- Only `http:`, `https:`, and `about:blank` are allowed.
- `file:`, `javascript:`, and other schemes are rejected.
- Loopback development hosts are allowed; unspecified, private, link-local, carrier-grade NAT, and IPv6 local ranges are blocked by default.
- Browser permissions for camera, microphone, geolocation, notifications, and similar capabilities are denied.
- Uploads resolve real paths and must remain inside the Session working directory or managed Barn roots.
- Consequential page actions create a durable Approval. The Agent waits for approval and never executes the action after a denial.
- Downloads use a unique filename in the configured Downloads directory.
- The renderer receives typed browser state and capture data only. Website DOM is not injected into the Barn renderer.
- Browser tab URLs and titles persist in a mode-0600 JSON file; cookies and site storage remain in Electron's dedicated browser session, not this file.

## Agent Computer provider boundary

Runtime capabilities advertise three Agent Computer providers:

- `built-in-browser`: available now, browser-session isolation.
- `secure-vm`: unavailable until a signed, on-demand VM runtime exists.
- `host-computer`: unavailable until OS screen-capture, accessibility, input, and approval flows exist.

The provider boundary keeps Secure VM and host Computer Use from changing the Browser and Agent Screen contracts.

## Visual verification

Hallmark's sloplint passes the browser and Agent Screen component scope with `Floor 0`, `Reflex 0 open`, and one documented waiver for the below-fold video-poster check. Real Electron screenshots cover the browser split, approval state, download/upload states, and the collapsed Agent Screen. The Hallmark render tier does not attach directly to an Electron `WebContentsView`, so the static tier and real Electron captures are used together.

## Known gaps

- Closed Shadow DOM and cross-origin iframe coverage is not available through the fixed semantic script.
- Agent Screen currently refreshes from page captures rather than a continuous WebRTC stream.
- Secure VM and host Computer Use are not implemented or bundled.
- A Chrome extension for the user's existing profile is not implemented.

## Verification

Real Electron e2e covers:

- opening and closing the split;
- Browser/Agent Screen mutual exclusion;
- Agent Screen gating on browser operations and compact split layout;
- real native browser content and captures;
- tab creation, switching, and closing;
- semantic observation, form fill, and submit;
- upload of an authorized workspace file;
- managed download to the configured Downloads directory;
- rejection of dangerous and metadata addresses.

Run:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm security:check
pnpm exec playwright test --workers=1
```
