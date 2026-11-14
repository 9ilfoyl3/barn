# Agent Note: Local file and schedule events become proposed Tasks

Status: implemented

## Problem

An always-on personal Agent needs a reason to act without a chat prompt. Connecting raw filesystem events or schedules directly to model execution would be noisy and unsafe. The agent first needs deterministic event capture, deduplication, cursors, and a safe proposal state.

## Decision

Desktop stores local source definitions and cursors in SQLite. Two source kinds ship initially:

- `file-watch` scans a selected folder, records a baseline, and detects new or changed files by path, size, and modification time.
- `schedule` fires at a fixed minute interval and advances its next-run cursor.

Source configurations, file signatures, source errors, and event prompts are encrypted. Symlinks are skipped during recursive scans. A unique `(source_id, event_key)` record deduplicates replay across polls and restarts.

Every new source event creates a `proposed` Task through the existing Task service. Proposed Tasks appear in Needs you and never execute until a person chooses Run or supplies instructions. This module therefore establishes deterministic event capture and the observe-first safety boundary; proactive ranking and attention-budget policy remain the next module.

The account menu exposes Local sources. The settings panel can add, pause, remove, and immediately check sources. Its isolated stylesheet preserves Barn's existing modal and token system and passes Hallmark component checks.

## Alternatives considered

**Call `fs.watch` and send each raw event to the model.** Rejected because editor saves create duplicate events, recursive watching behaves differently across platforms, and no replay cursor exists.

**Write changes directly into queued Tasks.** Rejected because environmental events need an observe-first proposal stage.

**Store absolute paths and prompts in plaintext.** Rejected because folder names and automation instructions can reveal sensitive office context.

**Block initial scan behind an explicit baseline action.** Rejected because the first scan can safely establish a baseline without generating noise.

## Consequences

- Local automation starts quietly: existing files do not immediately create suggestions.
- File changes and scheduled checks are deduplicated and replay-safe.
- Source failures stay on the source and do not stop other sources.
- Folder scanning reads metadata only; it does not inspect file content.
- The next module can add ranking, attention budgets, and observe/auto policy without changing the source contract.
