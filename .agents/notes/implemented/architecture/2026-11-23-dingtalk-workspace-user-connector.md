# Agent Note: DingTalk uses a user-authorized local connector

Status: implemented

## Problem

The original DingTalk connector supported only a group robot webhook. It could send notifications but could not search messages or contacts, read calendar items or tasks, or use the user's own DingTalk identity. A webhook also made each connection a separate credential rather than an account connection.

## Decision

The built-in DingTalk connector is now a user-authorized local connector. Its user-facing flow has only three visible steps: confirm installation, complete browser authorization, and finish. Product copy does not mention the underlying command-line runtime.

Barn downloads a pinned official DingTalk component release for the current macOS, Windows, Linux, or OpenHarmony architecture, verifies its SHA-256 checksum, extracts only the executable into Barn's user-data directory, and runs it with a Barn-specific configuration directory. The process environment removes inherited runtime overrides and sets skill installation off so the component cannot modify global Agent skill directories.

The component owns OAuth token storage and refresh in the operating-system credential store. Barn stores no DingTalk token in connector credentials. Connector readiness is created only after authorization succeeds. Removing the connector attempts a local DingTalk logout before reloading the connector list.

At startup, Barn also clears legacy DingTalk Webhook and signing credentials from existing connector records. It keeps the record itself so the user can sign in again, but removes secrets that the account connector no longer uses.

The first capability set is: contact search, calendar list, task list, message search, recent message reading, and sending a message as the signed-in user. Reads use the connector external-read policy. DingTalk sending is an explicit product exception: the capability is marked `requiresApproval: false`, so the allowlisted send command executes immediately and returns its result without creating an approval action. Other connector writes retain the approval queue.

## Alternatives considered

**Keep the webhook robot connector.** Rejected because the user asked to replace it and because it cannot provide user-scoped workspace data.

**Execute `curl | sh` or a global npm installer when Add is clicked.** Rejected because it downloads and executes an unpinned remote script, may mutate global Skill directories, and is harder to audit and repair.

**Expose a generic command runner to the Worker.** Rejected because the DingTalk component exposes a much wider command surface than Barn should grant. The adapter maps only named connector capabilities to fixed argv arrays.

**Store OAuth tokens in Barn's connector credential file.** Rejected because the component already provides OAuth refresh and OS-backed token storage; duplicating the token lifecycle would create two sources of truth.

**Require approval for DingTalk sends.** Rejected for this connector because the user explicitly wants conversational DingTalk replies to send directly as the signed-in user. Direct execution remains limited to the fixed send capability; all other external writes continue through approval.

## Consequences

- The DingTalk card now represents an account connection, not a robot webhook.
- Private user-identity reads and message sends use the connector discovery boundary; DingTalk sends execute directly by explicit product choice, while other connector writes retain approvals.
- Installation requires network access and approximately 20 MB of download space; the component is kept under Barn's user-data directory and can be repaired by reinstalling.
- Authentication requires the organization to enable CLI access; the UI surfaces this as a sign-in failure rather than exposing implementation terminology.
- Future work can add more allowlisted DingTalk capabilities without changing the install and authorization flow.
