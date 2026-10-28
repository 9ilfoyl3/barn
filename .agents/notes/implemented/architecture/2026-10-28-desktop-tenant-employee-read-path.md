# Agent Note: Desktop employee reads flow through Host IPC and typed HR client

Status: implemented

## Problem

Desktop could create employee intake drafts and commit them, but the Workspace and Agent had no tenant-scoped way to search existing employees or read their current organization, manager, hire date, and lifecycle status. Letting the renderer or Worker call the HR API directly would expose access tokens and bypass the Host security boundary.

## Decision

The Electron Host owns the `HrClient`. It obtains short-lived access tokens from `AuthService`, calls the HR API with bearer authentication, and exposes only typed read methods over trusted IPC: employee search, employee detail, organization detail, and the legacy employee list.

The renderer receives employee summaries and details, never tokens. Workspace employee search supports text, lifecycle status, organization code, pagination, and a detail panel for current assignment, manager, hire date, location, work email, and version. Logout and Workspace close clear the in-memory employee result and detail state.

The Agent Worker receives four read-only tools through the existing Host tool protocol: `employee_search`, `employee_get`, `org_unit_get`, and `employee_list_by_org`. The tools return read-only context and cannot authorize writes. The system prompt tells the Agent to require Cloud sign-in and never use stale employee data as write authorization.

## Alternatives considered

**Call the HR API from the renderer.** Rejected because the renderer has no access to credentials or refresh tokens and runs under a stricter security boundary.

**Give the Worker direct network and token access.** Rejected because the Agent Worker must not hold user credentials or bypass Host request validation.

**Expose raw SQL or database credentials to Agent tools.** Rejected because all HR access must pass through identity and tenant authorization.

**Keep the Workspace as a fixed list capped at 500 employees.** Rejected because RBAC and larger tenants require server-side search, filtering, and pagination.

## Consequences

- the Host remains the only component that handles HR access tokens;
- Workspace and Agent reads use the same HR API contract and tenant context;
- logout clears current employee UI state and the encrypted tenant read cache described in [Encrypted tenant HR read cache](2026-10-28-encrypted-tenant-hr-read-cache.md);
- employee detail links back to related intake and sessions remain follow-up work;
- cached reads are display-only and never authorize writes; organization-scoped authorization remains required before broader HR writes are allowed.
