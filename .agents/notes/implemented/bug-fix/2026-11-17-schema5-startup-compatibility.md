# Agent Note: Schema 5 databases start without downgrade or data loss

Status: implemented

## Problem

An existing Barn database reported schema version 5 while the current source supported only version 4. Startup rejected the database and surfaced the rejection as an unhandled promise rejection, so the Desktop did not open.

The same startup path also used deprecated synchronous `safeStorage` APIs.

## Decision

The current supported schema version is 5. The actual schema-5 database contains the same session, task, permission, action, source, and memory tables and columns that the current idempotent initializers create. Schema 6 and later still fail closed.

Application startup now catches initialization failures, logs the message, shows an error dialog, and quits instead of leaving an unhandled rejection.

Credential and device-key encryption use `safeStorage.isAsyncEncryptionAvailable()`, `encryptStringAsync()`, and `decryptStringAsync()`. Existing encrypted files remain compatible because the async decryptor reads data produced by the synchronous API.

## Alternatives considered

**Delete or recreate the database.** Rejected because it destroys Sessions, Tasks, approvals, actions, sources, and memories.

**Ignore schema versions entirely.** Rejected because a genuinely newer schema can contain data the current binary cannot safely interpret.

**Downgrade schema metadata to 4.** Rejected because it hides the compatibility decision and allows the same failure on the next launch.

**Keep the unhandled startup rejection.** Rejected because a corrupt, locked, or unsupported database should produce a clear user-facing failure.

## Consequences

- Existing schema-4 databases are upgraded to schema 5 during normal initialization.
- Schema-5 databases preserve their data and start normally.
- Schema 6 and later continue to fail closed.
- Credential encryption no longer emits Electron's synchronous `safeStorage` deprecation warnings.
- Startup errors are reported once through a native error dialog.
