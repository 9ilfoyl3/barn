# Barn Desktop Agent Loop and Cross-Platform Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the local Codex-like Agent loop, durable chat sessions, local file/output tools, and enforcing macOS and Windows shell backends.

**Architecture:** Electron Host owns credentials, SQLite Sessions, sandbox policy, and Worker lifecycle. A dedicated Agent Worker runs Pi Agent Core and invokes model streaming through a Host broker so provider credentials never enter the Worker. Platform sandbox adapters execute local capabilities or fail closed.

**Tech Stack:** Electron 45, React 19, TypeScript, Pi Agent Core 1.4, pi-ai 1.4, Node SQLite, Electron safeStorage, electron-builder, Playwright, Vitest.

---

## 1. Current Baseline

Implemented and verified:

- independent `barn-desktop` Git repository;
- Electron security boundary and packaged renderer;
- all built-in pi-ai providers plus custom provider configuration;
- simplified custom-provider setup with API key, default-model selection, and connection testing;
- reusable provider form for create and edit flows, including multiple model configurations;
- Volcengine Ark preset using the standard OpenAI Responses API;
- local encrypted model credentials and default-model selection;
- encrypted Session event storage and Session list/create;
- typed Agent Worker protocol, utility-process supervisor, bounded restart, and crash cleanup;
- Host-owned model stream broker that keeps provider credentials out of the Worker;
- multi-turn Pi Agent loop with durable complete-message persistence, streaming deltas, cancellation, and Session restore;
- streaming chat UI with model/run errors and live tool status;
- managed attachment import with unrestricted file selection;
- generic `read_file`, `list_dir`, `search_files`, `view_image`, and sandboxed `shell` tools;
- deterministic model-context compaction with complete persistent history, tool-pair preservation, and context usage reporting;
- macOS Seatbelt shell policy and executable write-boundary test;
- Windows fail-closed platform capability;
- macOS package and Windows packaging CI matrix;
- Agent Notes validation.

Current limitation:

- write, patch, and output-directory tools are not connected;
- Windows shell is unavailable until its enforcing backend lands;
- employee-intake draft tools and Cloud HR preview/commit integration are implemented; lifecycle workflows remain future work.

## 2. Execution Order

Run the first three tasks in one session, verify, then continue:

1. Agent Worker protocol and lifecycle.
2. Host-owned model stream broker.
3. Pi loop and durable chat events.

After that:

4. Chat UI and cancellation.
5. Local file and output capabilities.
6. Windows AppContainer/Job Object backend.
7. Release hardening.

---

## Task 1: Agent Worker Protocol and Supervisor

**Files:**

- Create: `src/main/worker/worker-protocol.ts`
- Create: `src/main/worker/worker-supervisor.ts`
- Create: `src/main/worker/worker-ipc.ts`
- Create: `src/worker/index.ts`
- Modify: `src/main/index.ts`
- Test: `tests/worker/worker-protocol.test.ts`
- Test: `tests/worker/worker-supervisor.test.ts`

**Step 1: Write protocol tests**

Cover:

- malformed Worker messages are rejected;
- every request has a unique request ID;
- stale request completions are ignored;
- Worker crash rejects outstanding requests;
- restart does not restart the renderer;
- shutdown drains active requests.

Run:

```sh
pnpm test -- tests/worker/worker-protocol.test.ts tests/worker/worker-supervisor.test.ts
```

Expected: FAIL because the Worker protocol is not implemented.

**Step 2: Implement the protocol**

Define discriminated unions:

```ts
type HostToWorker =
  | { type: 'worker.initialize'; requestId: string }
  | { type: 'session.open'; requestId: string; session: WorkerSessionSeed }
  | { type: 'session.prompt'; requestId: string; sessionId: string; text: string }
  | { type: 'session.cancel'; requestId: string; sessionId: string }
  | { type: 'model.event'; requestId: string; event: unknown }
  | { type: 'shutdown' }

type WorkerToHost =
  | { type: 'worker.ready' }
  | { type: 'request.error'; requestId: string; error: string }
  | { type: 'session.append'; requestId: string; sessionId: string; events: NewSessionEvent[] }
  | { type: 'run.status'; sessionId: string; runId: string; status: string }
  | { type: 'model.start'; requestId: string; sessionId: string; selection: ModelSelection; context: unknown }
  | { type: 'model.abort'; requestId: string }
  | { type: 'assistant.delta'; sessionId: string; runId: string; delta: string }
```

Validate every external payload with Zod.

**Step 3: Implement the supervisor**

- start `utilityProcess.fork()` for `out/worker/index.js`;
- expose typed request/response and event APIs;
- track outstanding requests;
- restart with bounded backoff;
- report `running`, `crashed`, and `ready` through a Host event channel;
- close the Worker before app quit.

**Step 4: Implement Worker bootstrap**

The Worker starts a minimal HTTP-free Node process, registers `process.parentPort` handlers, and sends `worker.ready`.

**Step 5: Verify and commit**

Run:

```sh
pnpm test -- tests/worker
pnpm typecheck
```

Expected: PASS.

```sh
git add src tests
git commit -m "feat: add Agent Worker supervisor"
```

---

## Task 2: Host-Owned Model Stream Broker

**Files:**

- Create: `src/main/models/model-stream-broker.ts`
- Create: `src/worker/model-stream-proxy.ts`
- Modify: `src/main/models/model-service.ts`
- Modify: `src/main/worker/worker-supervisor.ts`
- Test: `tests/models/model-stream-broker.test.ts`
- Test: `tests/worker/model-stream-proxy.test.ts`

**Step 1: Write broker tests**

Cover:

- Worker never receives provider credentials;
- Host resolves the selected model from its own `Models` collection;
- text, reasoning, and tool-call events are forwarded in order;
- cancellation aborts the Host provider stream;
- a Worker crash cancels the provider request;
- an error becomes a terminal model event.

Run:

```sh
pnpm test -- tests/models/model-stream-broker.test.ts tests/worker/model-stream-proxy.test.ts
```

Expected: FAIL.

**Step 2: Extend ModelService**

Expose:

```ts
interface ModelService {
  stream(input: {
    selection: ModelSelection
    context: Context
    signal: AbortSignal
  }): AssistantMessageEventStream
}
```

ModelService resolves the model and calls its own `models.streamSimple()`. The credential store remains in Host memory.

**Step 3: Implement the broker**

Host receives `model.start`.

For each provider event:

```ts
assertJsonSerializable(event)
worker.postMessage({ type: 'model.event', requestId, event })
```

On `model.event`, the Worker pushes the event into a local `EventStream`. On `model.abort`, Host aborts the provider controller and closes the stream.

**Step 4: Add crash cleanup**

Track model requests by Worker request ID. When the Worker exits:

- abort all provider streams;
- delete request state;
- reject pending start promises.

**Step 5: Verify and commit**

Run:

```sh
pnpm test -- tests/models tests/worker
pnpm typecheck
```

Expected: PASS.

```sh
git add src tests
git commit -m "feat: broker model streams through Electron Host"
```

---

## Task 3: Pi Agent Loop and Durable Chat Events

**Files:**

- Create: `src/worker/agent-runtime.ts`
- Create: `src/worker/event-mapper.ts`
- Create: `src/worker/session-projection.ts`
- Modify: `src/main/session/session-ipc.ts`
- Modify: `src/main/session/session-store.ts`
- Modify: `src/shared/models.ts`
- Test: `tests/worker/agent-runtime.test.ts`
- Test: `tests/worker/event-mapper.test.ts`
- Test: `tests/session/chat-persistence.test.ts`

**Step 1: Write a scripted model loop test**

Use a fake model stream with:

```text
user prompt
assistant text delta
assistant final message
```

Assert:

- `run/start` is stored before the model call;
- user input is persisted once;
- live deltas are not stored individually;
- the final assistant message is stored;
- `run/end` closes the run;
- replay reconstructs the same conversation.

Run:

```sh
pnpm test -- tests/worker/agent-runtime.test.ts tests/worker/event-mapper.test.ts tests/session/chat-persistence.test.ts
```

Expected: FAIL.

**Step 2: Seed Session projection**

Host reads stored events and sends a `WorkerSessionSeed`:

```ts
interface WorkerSessionSeed {
  sessionId: string
  messages: AgentMessage[]
  model?: ModelSelection
}
```

Do not send provider credentials.

**Step 3: Implement the Pi Agent**

```ts
const agent = new Agent({
  streamFn: proxy.streamSimple,
  initialState: {
    systemPrompt: renderBarnSystemPrompt(),
    messages: seed.messages,
    model,
  },
  convertToLlm,
})
```

Subscribe to Agent events, map them to Session events, send them to Host, and await the Host append acknowledgement before continuing.

**Step 4: Implement cancellation**

- Host sends `session.cancel`;
- Worker calls `agent.abort()`;
- model broker aborts the provider stream;
- Host closes the run as cancelled;
- late events are ignored.

**Step 5: Verify and commit**

Run:

```sh
pnpm test
pnpm typecheck
```

Expected: PASS.

```sh
git add src tests
git commit -m "feat: add durable Pi Agent chat loop"
```

---

## Task 4: Chat UI, Streaming, and Session Restore

**Files:**

- Create: `src/renderer/chat/ChatView.tsx`
- Create: `src/renderer/chat/MessageList.tsx`
- Create: `src/renderer/chat/Composer.tsx`
- Create: `src/renderer/chat/useAgentSession.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/App.tsx`
- Test: `tests/e2e/chat.spec.ts`

**Step 1: Write E2E tests**

Cover:

- choose model;
- create Session;
- submit prompt;
- stream assistant text;
- switch Sessions and restore history;
- reload app and restore history;
- cancel an active run.

Run:

```sh
pnpm test:e2e -- tests/e2e/chat.spec.ts
```

Expected: FAIL.

**Step 2: Implement streaming IPC**

Use a narrow preload event subscription:

```ts
sessions.onEvent((event) => void)
sessions.send({ sessionId, text })
sessions.cancel(sessionId)
```

Do not expose raw `ipcRenderer`.

**Step 3: Implement UI states**

- empty composer;
- model unavailable;
- provider unconfigured;
- running and cancel;
- streaming assistant response;
- restored transcript;
- run error.

**Step 4: Verify and commit**

Run:

```sh
pnpm test
pnpm test:e2e
pnpm typecheck
```

Expected: PASS.

```sh
git add src tests
git commit -m "feat: add streaming chat UI"
```

---

## Task 5: Local File, Search, and Output Capabilities

**Files:**

- Create: `src/main/files/execution-world.ts`
- Create: `src/main/files/file-tools.ts`
- Create: `src/main/output/output-manager.ts`
- Create: `src/main/tools/tool-registry.ts`
- Create: `src/worker/tools/local-tool-proxy.ts`
- Modify: `src/main/sandbox/policy.ts`
- Test: `tests/files/path-boundary.test.ts`
- Test: `tests/files/file-tools.test.ts`
- Test: `tests/e2e/output.spec.ts`

**Step 1: Write boundary tests**

Cover:

- read and write stay inside workspace/output roots;
- path traversal fails;
- symlinks cannot escape roots;
- output files use private permissions;
- `.env`, SSH, cloud credential, and Keychain paths are denied;
- tool calls route through one ExecutionWorld.

**Step 2: Implement tools**

- `read_file`;
- `write_file`;
- `apply_patch`;
- `list_dir`;
- `search_files`;
- `open_output_directory`.

All typed and model-facing through Pi capability wrappers.

**Step 3: Verify and commit**

Run:

```sh
pnpm test -- tests/files tests/e2e/output.spec.ts
pnpm typecheck
git add src tests
git commit -m "feat: add sandboxed local file capabilities"
```

Expected: PASS.

---

## Task 6: Windows AppContainer and Job Object Backend

**Files:**

- Create: `native/windows-sandbox/Cargo.toml`
- Create: `native/windows-sandbox/src/main.rs`
- Create: `src/main/sandbox/windows-appcontainer.ts`
- Modify: `src/main/sandbox/shell-service.ts`
- Modify: `src/main/platform/runtime-capabilities.ts`
- Test: `native/windows-sandbox/tests/smoke.rs`
- Test: `tests/sandbox/windows-capabilities.test.ts`
- Modify: `.github/workflows/desktop.yml`

**Step 1: Write Windows integration tests**

Run only on `windows-latest`:

- command writes inside workspace;
- command cannot write outside workspace;
- command cannot create an external network connection;
- child process cannot escape the Job Object;
- timeout kills the full process tree;
- environment excludes credentials.

**Step 2: Implement the native helper**

The helper accepts a JSON request and enforces:

- AppContainer without internet capability;
- writable directory ACL grants;
- restricted environment;
- Job Object kill-on-close;
- captured stdout/stderr;
- timeout and cancellation.

It must fail before spawning when any setup call fails.

**Step 3: Integrate the backend**

`ShellService` selects `windows-appcontainer` on Windows.

Until the helper passes Windows CI, runtime capabilities must continue to report Shell unavailable.

**Step 4: Verify and commit**

Run on Windows:

```sh
cargo test --manifest-path native/windows-sandbox/Cargo.toml
pnpm test
pnpm typecheck
pnpm package:win:dir
```

Expected: PASS.

```sh
git add native src tests .github
git commit -m "feat: add Windows AppContainer sandbox"
```

---

## Task 7: Release Hardening

**Files:**

- Create: `build/icon.icns`
- Create: `build/icon.ico`
- Modify: `electron-builder.yml`
- Modify: `.github/workflows/desktop.yml`
- Create: `docs/release-runbook.md`

**Step 1: Add platform signing inputs**

- macOS Developer ID certificate and notarization credentials;
- Windows code-signing certificate;
- update feed configuration.

Do not commit credentials.

**Step 2: Add release checks**

- macOS notarized DMG launches;
- Windows signed NSIS installs and launches;
- uninstall removes app binaries but preserves user Session data;
- auto-update verifies signatures.

**Step 3: Run release gate**

```sh
pnpm docs:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm package:mac
pnpm package:win
```

Expected: all pass on their native runners.

## 3. Acceptance Criteria

Desktop next-stage is complete when:

1. a user can configure any built-in pi-ai provider or a custom provider locally;
2. prompts stream through Pi Agent Core into the UI;
3. Session history survives app restart;
4. cancellation stops provider and tool work;
5. read/write/search tools obey one sandbox boundary;
6. output files are written under the local output directory;
7. macOS Seatbelt tests pass;
8. Windows AppContainer tests pass before Windows Shell is reported available;
9. packaged macOS and Windows apps launch;
10. Agent Notes and all quality gates pass.

## 4. Risks

- Pi event serialization through the Host broker can reorder or drop transient frames.
- macOS Seatbelt is platform-deprecated and requires startup self-tests.
- Windows AppContainer setup and ACL propagation are the highest-risk native work.
- SQLite `node:sqlite` is still experimental in the Node line used by tests; Electron 45 bundles Node 24.22.
- Provider-specific OAuth login remains separate from API-key setup.
