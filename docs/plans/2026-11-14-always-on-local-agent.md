# Barn Desktop Always-on Personal Agent Plan

## Goal

Evolve Barn Desktop from a local-first interactive agent into a production-grade always-on personal agent without introducing a hosted control plane.

The product remains:

- local-first;
- beginner-friendly;
- safe by default;
- explicit before consequential external or destructive actions;
- visually consistent with the existing Barn Desktop UI.

## Delivery protocol

1. Start every module from the current remote `develop`.
2. Use one branch per module named `feature/<topic>`, `fix/<topic>`, or `refactor/<topic>`.
3. Include implementation, durable Agent Note, and tests in the module PR.
4. Run `pnpm docs:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
5. Run affected Electron end-to-end tests for runtime or UI changes.
6. Run Hallmark audit and `sloplint` for every UI module while preserving the existing visual system.
7. Open a PR to `develop`; only then begin the next module from updated `develop`.

## Modules

### 1. Task domain and persistence

Branch: `feature/task-domain-foundation`

- durable Task model separate from Session;
- enforced task state machine;
- SQLite persistence and restart recovery;
- typed IPC and preload bridge;
- task change events for later runtime and UI modules.

Acceptance: store/service tests, full suite, typecheck, lint, docs check, production build.

### 2. Background task execution

Branch: `feature/background-task-execution`

- Task runner that can create or reuse a Session;
- asynchronous run events and cancellation;
- serialized task commands;
- restart recovery for queued/running tasks.

Acceptance: runner integration tests, restart-recovery tests, AgentService regression tests.

### 3. Needs You inbox and task center

Branch: `feature/needs-you-inbox`

- task list in the existing sidebar or secondary surface;
- waiting/proposed/done grouping;
- actions for accept, dismiss, retry, and open Session;
- loading, empty, error, keyboard, and screen-reader states.

Acceptance: renderer tests, Electron e2e, Hallmark audit, `sloplint --render`.

### 4. Permission policy and approvals

Branch: `feature/permission-policy`

- simple personal policy for local read, workspace write, external write, and destructive actions;
- durable approval requests;
- policy changes remain independent from untrusted model content.

Acceptance: policy unit tests, IPC contract tests, bypass and fail-closed tests.

### 5. Durable action outbox

Branch: `feature/action-outbox`

- persistent side-effect intents;
- idempotent execution and retry;
- cancellation and crash recovery;
- audit trail for external writes.

Acceptance: idempotency, retry, restart, and duplicate-delivery tests.

### 6. Local event sources

Branch: `feature/local-event-sources`

- source abstraction;
- deterministic filters;
- filesystem watcher and scheduled trigger;
- event cursor/replay behavior.

Acceptance: deterministic filter tests, watcher lifecycle tests, duplicate-event tests, runtime e2e.

### 7. Observe mode and proactive suggestions

Branch: `feature/proactive-observe-mode`

- observe-only suggestions before automation;
- deduplication and attention budget;
- clear “would do” proposals in the Needs You inbox.

Acceptance: candidate lifecycle tests, UX tests, Hallmark audit.

### 8. Always-on lifecycle

Branch: `feature/always-on-lifecycle`

- tray/menu-bar residency;
- close-to-background behavior;
- optional launch at login;
- sleep/wake and network recovery;
- OS notifications only for actionable events.

Acceptance: lifecycle unit tests, platform packaging tests, Electron e2e, Hallmark audit.

### 9. Production hardening

Branch: `refactor/production-hardening`

- retention and compaction policy;
- diagnostics and health surface;
- security review of IPC, permissions, and external actions;
- upgrade/migration tests;
- signed packaging and release checklist.

Acceptance: full regression suite, packaged-app smoke tests, cross-platform CI, release checklist.
