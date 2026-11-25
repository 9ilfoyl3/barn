# Router, Worker, and Task Runtime Implementation Plan

**Goal:** Redesign Barn's front-door Router from a one-shot Task classifier into a bounded tool-using coordinator that can answer simple connector questions directly, while keeping durable Task execution as the default for multi-step work.

**Architecture:** The Router receives role-layered prompts plus a small `call` envelope for connector discovery/read-only access and one final `route_decision` tool. The Worker keeps its isolated per-Task execution loop but receives a composed role prompt and a smaller Task brief. Task follow-ups on active work dispatch directly to the Worker; only terminal, waiting, or ambiguous coordination messages use the Task Router model.

**Tech Stack:** Electron 45, TypeScript, Pi Agent Core/Pi AI, Zod, TypeBox, SQLite, Vitest, Playwright Electron E2E.

---

## Acceptance criteria

- A simple question answerable from visible context is replied to directly with no Task.
- A connector discovery question can be answered by the Router directly with no Task.
- A single connector read can be performed by the Router in the same user turn; external writes remain unavailable to the Router's direct connector surface.
- Multi-step, background, file-producing, browser, shell, or external-write work still becomes a durable Task.
- Router and Worker prompts share stable layered sections rather than duplicating role rules as separate prose blobs.
- `task.create` no longer requires the model to invent acceptance criteria, artifact lists, or risk analysis for trivial work.
- Follow-ups on an active Task dispatch directly to its Worker without an extra Task Router model call.
- Unit, integration, security, typecheck, lint, and focused Electron E2E tests pass.
- A real-model Electron conversation smoke test using the user's existing encrypted model configuration passes before the PR is opened.

## Task 1: Layered prompt composition

**Files:**
- Create: `src/shared/agent-prompts.ts`
- Modify: `src/main/router/router-decision.ts`
- Modify: `src/worker/worker-runtime.ts`
- Test: `tests/prompt/agent-prompts.test.ts`

Steps:
1. Add failing tests asserting section order and role-specific connector/task rules.
2. Implement shared identity/runtime/collaboration/delivery/tool sections and Router/Worker composers.
3. Replace inline Router and Worker prompt constants with the composers.
4. Verify unit tests and typecheck.

## Task 2: Router-owned read-only connector loop

**Files:**
- Modify: `src/main/connectors/connector-service.ts`
- Modify: `src/main/router/router-decision.ts`
- Modify: `src/main/index.ts`
- Test: `tests/router/router-decision.test.ts`
- Test: `tests/connectors/connector-service.test.ts`
- Test: `tests/e2e/router-connector-discovery.spec.ts`

Steps:
1. Add a failing test proving `call(connector.list)` is executed and followed by `route_decision(reply)` without Task creation.
2. Add a failing test proving `call(connector.read)` returns connector data to the Router and rejects write capabilities.
3. Implement a bounded multi-round Router loop with final `route_decision` validation.
4. Add `ConnectorService.callRead` and wire the Router gateway into `index.ts`.
5. Add deterministic Electron E2E for direct connector discovery and zero tasks.

## Task 3: Smaller Task contract and Worker brief

**Files:**
- Modify: `src/main/router/router-decision.ts`
- Modify: `src/main/router/router-service.ts`
- Test: `tests/router/router-decision.test.ts`

Steps:
1. Change `task.create` arguments so only title and objective are required.
2. Fill safe host defaults for deliverable, criteria, risk, lane, and artifacts.
3. Replace raw contract JSON in the Worker prompt with a readable Task brief.
4. Verify Task behavior and existing routing tests.

## Task 4: Direct active-Task follow-ups

**Files:**
- Modify: `src/main/tasks/task-conversation-service.ts`
- Test: `tests/tasks/task-conversation-service.test.ts`
- Test: `tests/e2e/task-router-coordination.spec.ts`

Steps:
1. Add a failing test that a running Task follow-up goes to the Worker without invoking the Task Router.
2. Add deterministic explicit-cancel handling for active Tasks.
3. Keep Task Router for terminal, waiting, review, approval, status, and ambiguous coordination messages.
4. Update the Electron Task coordination E2E.

## Task 5: Real-model verification and PR gate

**Files:**
- Create: `tests/e2e/live-model.spec.ts` (environment-gated)
- Create or update: `docs/testing.md` if needed

Steps:
1. Copy the user's existing encrypted model configuration into an isolated temporary Electron user-data directory.
2. Run a real-model direct-answer conversation and verify no Task is created.
3. Run a real-model connector-discovery conversation and verify no Task is created.
4. Run a real-model durable file Task and a follow-up; verify Worker completion.
5. Run full unit tests, typecheck, lint, security check, and focused E2E.
6. Commit and open a PR only after every gate passes.
