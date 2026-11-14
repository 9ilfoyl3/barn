# Agent Note: Production hardening adds schema, retention, diagnostics, and release gates

Status: implemented

## Problem

A research-quality local Agent can accumulate unbounded history, hide operational failures, and ship unsigned or incompletely verified packages. Production use needs explicit schema compatibility, bounded auxiliary history, inspectable local health, repeatable security checks, and a release process.

## Decision

SQLite now stores a schema version and refuses a database created by a newer app version. Existing pre-version databases migrate in place and receive a schema version and retention defaults. This prevents silent downgrade or interpretation of unknown future state.

Auxiliary audit data uses a configurable retention window, defaulting to 365 days. Cleanup runs at startup and daily, and can be run manually from Diagnostics. It removes old Action audit events, old unreferenced source events, and old resolved approvals. It deliberately does not delete Tasks, Sessions, pending approvals, active Actions, or their parent records.

Diagnostics reports app/runtime versions, schema version, local data directory, Task/Session/Approval/Action/source counts, automation mode, shell sandbox status, retention, and last cleanup. It also provides retention editing and manual cleanup.

`pnpm security:check` statically verifies that each Electron IPC handler has a trusted-sender guard. Security and release threat-model/checklist documents cover signing, notarization, rollback, and manual acceptance.

macOS packaging uses hardened runtime and explicit entitlements. The release workflow builds macOS and Windows installers and uploads artifacts. Signing credentials remain external GitHub secrets.

## Alternatives considered

**Delete all old Sessions automatically.** Rejected because user-visible work history is valuable and deletion should be a separate explicit product decision.

**Keep audit data forever.** Rejected because local storage would grow without bound.

**Trust developer discipline for IPC guards.** Rejected because a missing guard is easy to introduce and mechanically detectable.

**Commit signing certificates or notarization credentials.** Rejected. Public releases require secrets injected by CI.

**Treat unsigned directory packages as release artifacts.** Rejected. They are verification builds only.

## Consequences

- Newer databases fail closed instead of being modified by older binaries.
- Auxiliary history is bounded without deleting Task/Session records.
- Local diagnostics are accessible without a hosted service.
- IPC guard regressions fail CI.
- Public release still requires valid Apple and Windows signing identities and manual clean-machine acceptance.
