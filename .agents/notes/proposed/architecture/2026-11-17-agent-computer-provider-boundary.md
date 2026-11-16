# Agent Note: Agent Computer providers share one capability boundary

Status: proposed

## Problem

Barn now has a real built-in browser and visible Agent Screen. Secure VM and host Computer Use are future execution surfaces, but bundling a Linux desktop image or exposing OS input without a stable boundary would inflate the client and couple every surface to one runtime.

## Proposal

Desktop exposes Agent Computer provider capabilities through the existing typed runtime capability bridge. The built-in Browser is the available default with browser-session isolation. Secure VM and host Computer Use are declared as unavailable providers until their dedicated runtimes, permissions, and packaging exist.

Future providers implement the same `AgentComputerProvider` lifecycle: start a Session-bound computer, stop it, and expose a screen/control surface to the existing Agent Screen UI. Provider-specific tool names may differ, but the Host remains the permission and artifact boundary.

## Alternatives considered

**Bundle a local VM image in the first release.** Rejected because it adds a large optional download and slows the default Browser path.

**Use the Electron browser surface as a fake VM.** Rejected because browser-session isolation and virtual-machine isolation have different security guarantees.

**Expose host Computer Use through the browser tools.** Rejected because host screen capture and input require separate OS permissions, foreground behavior, and approvals.

## Acceptance criteria

- runtime capabilities list Browser, Secure VM, and host Computer Use with honest availability;
- the built-in Browser remains the default provider;
- unavailable providers never execute tools or claim support;
- future providers can implement the same start/stop and screen boundary without changing the Agent Screen contract;
- diagnostics can expose provider availability without requiring a hosted control plane.

## Risks

- Secure VM distribution and updates need signing, rollback, and platform-specific hypervisor work.
- Host Computer Use has a larger blast radius and requires application allowlists plus explicit OS permissions.
- Browser-session isolation is not equivalent to VM isolation and must remain clearly labeled.
