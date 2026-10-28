# Agent Note: HR reads use an encrypted tenant-scoped display cache

Status: implemented

## Problem

Authenticated Desktop users need recently viewed employee data to remain available when the HR API is briefly unreachable. A persistent cache must not leak plaintext HR data, mix accounts or tenants, outlive its freshness window, or become authority for a write after the server version changes.

## Decision

The Electron Host owns a read-through HR cache. Cache files live under `accounts/<user>/tenants/<tenant>/cache/hr-read-cache.bin` and are encrypted with the existing device data key using AES-256-GCM. The user and tenant IDs are associated data, so a file copied to another account or tenant partition fails authentication.

Search, employee-detail, and organization-detail reads first try an exact-query cache entry. A fresh hit returns read-only cached data without acquiring an access token. A miss performs the authenticated HR request and stores the result best-effort. Cache entries expire after five minutes by default, configurable with `BARN_HR_CACHE_TTL_MS`; expired entries are deleted and never returned as stale fallback.

Intake preview and commit always use the network and never consult the cache. A successful commit clears the current tenant cache. Logout awaits cache deletion, and activating a different user or tenant removes the previous scope before accepting data from the new scope.

The renderer and Agent receive explicit `cache.source = "cache" | "network"` metadata. Cached employee data is labeled read-only and cannot authorize lifecycle, approval, commit, or other write operations.

## Alternatives considered

**Keep HR reads only in renderer memory.** Rejected because the cache would disappear on navigation or reload and would move sensitive data outside the Host boundary.

**Use a plaintext JSON or SQLite cache.** Rejected because employee records must remain encrypted at rest.

**Reuse expired data when the API is offline.** Rejected because the acceptance criteria require stale data to stop participating in reads and writes after TTL expiry.

**Queue HR writes while offline.** Rejected because version conflicts and authorization changes cannot be resolved safely without a current server check.

**Give every cache entry its own OS-keyring secret.** Rejected because one device data key with per-scope associated data provides the required isolation without multiplying key-management operations.

## Consequences

- offline reads are limited to exact queries that were cached during the TTL window;
- cache write, repair, or deletion failures do not fail a successful online read or commit;
- stale entries fail closed, while cache infrastructure failures degrade to normal network behavior;
- the Agent can explain that displayed data came from cache but cannot perform writes from it;
- lifecycle proposal creation and decisions clear the current tenant read cache;
- Session and workspace files are not yet partitioned by account and tenant, so full local data partitioning remains follow-up work;
- restoring a signed-in session while both the network and refresher are unavailable remains a separate offline-authentication problem.
