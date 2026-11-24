# Agent Note: Connector arguments have advertised, executable contracts

Status: implemented

## Problem

A DingTalk send action queued before direct sends used `text` as its message body. Newer adapter validation expected `content`, so every automatic retry failed with `Unrecognized key: "text"` and exhausted its attempts. The adapter now normalizes legacy `text` to `content`, and failed actions can retry through the current contract.

The same class of error could recur for other built-in connectors because only DingTalk advertised JSON input schemas. Email and GitHub adapters use strict argument validation, but the Worker saw no property names or required fields and had to guess them.

## Decision

Every built-in connector capability exposed by `connector_list` advertises an input contract. DingTalk, Email, and GitHub use closed JSON schemas with exact property names, required fields, and bounds matching their adapter validation. DingTalk retains one-way compatibility for legacy `text`, while its advertised schema requires `content` for new calls.

## Alternatives considered

**Drop strict adapter validation.** Rejected because unknown fields often indicate a malformed or unsafe call, and silently ignoring them can execute the wrong external effect.

**Advertise every connector as an open object.** Rejected because it gives the Worker no reliable contract and preserves the guessing behavior that caused the failure.

**Keep DingTalk-only compatibility without exposing the other schemas.** Rejected because Email and GitHub remain vulnerable to the same argument-name mismatch.

## Consequences

- Retrying the existing failed DingTalk action uses the same payload and now maps `text` to the command's `--content` argument.
- New DingTalk calls use `content`; no new action is created for direct sends.
- The Worker receives exact Email and GitHub argument contracts before calling them.
