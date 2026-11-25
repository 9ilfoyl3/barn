# Barn Desktop Release Checklist

## Required checks

- `pnpm install --frozen-lockfile`
- `pnpm docs:check`
- `pnpm lint`
- `pnpm security:check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm package:mac`
- `pnpm package:win`

When a real model provider is configured, run the live Electron smoke test against an isolated copy of the encrypted model configuration:

```sh
BARN_LIVE_MODEL_USER_DATA="$HOME/Library/Application Support/barn-desktop" \
BARN_LIVE_MODEL_APP="$PWD/release/mac-arm64/Barn.app/Contents/MacOS/Barn" \
pnpm exec playwright test tests/e2e/live-model.spec.ts --workers=1
```

## Signing and notarization

macOS secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Windows secrets:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

Unsigned local directory builds are allowed for verification only. Public releases must be signed and, on macOS, notarized.

## Manual acceptance

1. Install on a clean macOS and Windows machine.
2. Verify local model/provider setup and encrypted credential storage.
3. Verify Session restore after quit and relaunch.
4. Verify a background Task survives app restart and completes.
5. Verify external write approval blocks execution until approved.
6. Verify the Action outbox does not duplicate a retried operation.
7. Verify folder/schedule sources start in Observe mode.
8. Verify close-to-background, tray recovery, launch-at-login, and notification routing.
9. Run Diagnostics cleanup on a copy of a large state directory.
10. Confirm no signing, credential, or user-data files are included in release artifacts.

## Rollback

Keep the previous signed installers and the database schema version. A newer database is refused by older app builds rather than being silently downgraded.
