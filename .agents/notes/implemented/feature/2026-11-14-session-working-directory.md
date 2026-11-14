# Agent Note: Sessions can select an explicit working directory and folder attachments

Status: implemented

## Problem

The composer previously showed a non-interactive agent identity chip, while every tool defaulted to Barn's hidden managed workspace. Users could only attach individual files. This did not match how office work is organized by folders and made selected local sources difficult to inspect.

## Decision

Each Session stores an optional working directory. The folder chip above the composer is now the directory selector. Selecting a folder for an existing Session persists it immediately; a new Session carries the selection into its first prompt.

When a working directory is present:

- relative file paths resolve from it;
- it is included in Host-approved read/write roots alongside Barn's workspace, output, and temp roots;
- Shell uses it as `cwd` and as the workspace-write sandbox root;
- the model prompt includes the current working directory.

Attachment selection is now a small menu with `Add files` and `Add folder`. Folders are recursively copied into the Session attachment directory, stored in the transcript as directory attachments, and displayed with folder icons.

The previous green-dot `Local workspace` label beside Attach is removed. The working-directory chip carries that context instead.

## Alternatives considered

**Use the selected directory directly as the managed workspace for the entire app.** Rejected because it would mix unrelated Sessions and weaken the stable default workspace.

**Copy the working directory into Barn instead of using it in place.** Rejected because the user explicitly asked for a current working directory, and copying would break ordinary folder workflows.

**Open separate file and folder dialogs from one button without a menu.** Rejected because native dialogs cannot reliably select files and directories together across platforms.

**Store only the working directory in renderer state.** Rejected because tool execution happens in the main process and the choice must survive restart.

## Consequences

- Users can work against real local folders rather than only copied files.
- Session summaries and tool execution share one working-directory value.
- Folder attachments are snapshots copied into the managed attachment area.
- Selecting a broad directory intentionally grants Agent read/write access inside that root, except for Barn's credential deny-list.
- Changing a working directory affects subsequent turns; earlier tool results keep their original paths.
