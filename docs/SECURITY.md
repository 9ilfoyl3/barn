# Barn Desktop Security Model

## Trust boundaries

- The Electron renderer is sandboxed with `contextIsolation`, no Node integration, navigation restrictions, and a narrow preload bridge.
- The Agent Worker has no provider credentials, database handle, or direct filesystem access. It calls typed Host capabilities.
- The Electron Host owns credentials, SQLite, shell policy, permissions, approvals, and the Action outbox.
- Model output, file contents, task instructions, source events, and external documents are untrusted data. They cannot approve their own actions.
- Every IPC handler is checked by `pnpm security:check` and must validate its payload with Zod at the process boundary.

## Local capabilities

- Shell execution uses an enforcing platform sandbox or fails closed.
- macOS Seatbelt denies network access, writes outside managed roots, and reads from selected credential directories.
- The shell environment is scrubbed of credential-like variables.
- File tools resolve real paths and reject traversal, symlink escape, and known secret files.
- Workspace discovery and content search skip symlinks, known secret paths, `.git`, `node_modules`, and entries ignored by the workspace-root `.gitignore`; results are bounded.
- Workspace writes resolve the nearest existing ancestor before creating a target, reject symlink escapes and sensitive paths, and use atomic file replacement.
- Cross-Session memory payloads are AES-GCM encrypted with the device key, workspace identity is keyed-hashed, credential-like content is rejected, and retrieved memory is injected as untrusted reference data.
- Background memory extraction is opt-in, sends a bounded transcript of user/assistant text to the configured model provider, excludes tool results and images, records retry state, and honors per-Session generation controls.
- A user-selected Session working directory becomes an additional authorized read/write root. Selecting a broad directory intentionally broadens the Agent's local capability boundary.
- Local source folder watches read metadata only and skip symlinks.
- Attachment image and text previews are read only from the managed attachment store and are size-limited. PDF and modern Office previews have a 50MB input cap and are parsed without executing embedded content; unsupported or binary formats fall back to an icon.

## Built-in browser

- The browser uses a dedicated persistent Electron session and a native `WebContentsView`; website content is never injected into the Barn renderer.
- Only HTTP, HTTPS, and `about:blank` are allowed.
- Loopback development hosts are allowed. Unspecified, private, link-local, carrier-grade NAT, metadata, and IPv6 local ranges are blocked by default.
- Browser permission requests are denied by default.
- Popups open as Barn browser tabs rather than unrestricted windows.
- Agent browser actions are fixed Host operations. The model cannot submit arbitrary JavaScript or raw CDP commands.
- File uploads resolve real paths and remain inside the Session working directory or managed Barn roots.
- Downloads use unique paths in the configured Downloads directory.
- Browser-session isolation is not equivalent to VM isolation. Secure VM and host Computer Use remain unavailable providers until their dedicated security and approval controls ship.

## Consequential actions

- External writes and destructive operations default to `ask`.
- Approvals are durable, encrypted, and resolvable only through the trusted Desktop surface.
- Actions use mandatory idempotency keys, encrypted payloads/results, audit events, retries, and crash recovery.
- Provider adapters must honor the idempotency key and must not bypass the permission/outbox path.

## Known risks

- Barn runs as the signed-in OS user. A dedicated OS account is still the strongest local isolation boundary.
- Prompt injection can influence reasoning inside an authorized task. The permission and approval boundary limits what can be executed, but it does not make untrusted content trustworthy.
- External providers vary in idempotency support; the outbox is at-least-once unless the provider deduplicates.
- Release signing and notarization credentials are external secrets and are not stored in the repository.
