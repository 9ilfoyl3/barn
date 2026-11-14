# Barn Desktop

A general-purpose, local-first personal Agent for everyday office work, built with Electron, React, Pi Agent Core, and pi-ai.

## Product Positioning

Barn Desktop is a personal local Agent, not an Agent built for one job role or industry. It should be useful to ordinary people doing everyday knowledge and office work, including users who have never used an Agent before.

The product should feel simple, direct, and safe:

- **General-purpose:** help with common office tasks instead of assuming a specialist workflow.
- **Beginner-friendly:** use plain language, sensible defaults, guided setup, and progressive disclosure rather than requiring prompt engineering or Agent knowledge.
- **Local-first:** keep local files, Session history, model credentials, and the core experience on the user's device.
- **Action-oriented:** turn a request into a useful result or a clear next step without making the user assemble tools manually.
- **Controllable:** explain consequential actions and ask for understandable confirmation before external writes or destructive operations.

The target use cases include document reading and summarization, writing and rewriting, spreadsheet analysis, structured data extraction, report and presentation preparation, meeting notes, local file organization, research synthesis, and repetitive multi-step office workflows.

Barn Desktop is intended to work as a self-contained local application. A hosted Barn account or control plane is not part of the product direction.

This README defines product positioning, not a committed feature roadmap. The next development direction is intentionally undecided.

## Architecture

The Electron Host owns model provider configuration, encrypted credentials, local capabilities, durable Task and Session storage. A dedicated Agent Worker runs Pi Agent Core and accesses local capabilities only through typed Host-owned interfaces. The renderer receives typed Task and Session events and never receives model credentials.

Tasks are the durable user-facing unit of work. A Session is the execution transcript that carries model context for one run. A Task may link to a Session, move to another Session, or wait without an active run. Queued Tasks with encrypted instructions run through a background Task runner; restart recovery detaches interrupted Sessions before relaunch. The Desktop exposes Tasks through a Needs you inbox grouped by attention, active work, and recent outcomes. Consequential external and destructive actions use durable approval records outside model control and execute through an idempotent, retryable Action outbox. Local folder and schedule sources convert deterministic events into proposed Tasks by default, with configurable attention limits and an explicit active mode.

Interactive model calls are made by the Desktop with the user's configured provider. The Desktop owns its provider catalog, credentials, default model, and reasoning-effort settings.

## Internationalization

Desktop UI supports English and Simplified Chinese. Other languages fall back to English. The language picker persists the selected language locally and keeps the document `lang` attribute in sync. If no preference has been saved, Desktop follows the operating system's preferred language. `BARN_UI_LANGUAGE=en|zh-CN` can override detection for tests or controlled deployments. Electron-native strings such as the attachment picker follow the same effective locale.

## Development

```sh
pnpm install --registry=https://registry.npmjs.org
pnpm dev
```

## Verification

```sh
pnpm docs:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
