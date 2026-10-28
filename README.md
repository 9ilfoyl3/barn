# Barn Desktop

Local-first HRBP desktop workspace built with Electron, React, Pi Agent Core, and pi-ai.

The Desktop owns its model provider catalog and credentials. Interactive model calls do not use a Barn Cloud model gateway.

Employee data reads require Barn Cloud sign-in. The Electron Host performs OIDC Authorization Code + PKCE login, keeps access tokens in memory, stores refresh tokens through `safeStorage`, and calls the HR API through a typed Host-owned client. The renderer and Agent Worker never receive access tokens. Signed-in users can search employees, filter by status or organization, inspect current assignment and manager details, manage lifecycle cases and tasks, receive in-app lifecycle notifications and reminders, and ask the Agent to read tenant-scoped employee data.

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
