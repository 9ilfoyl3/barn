# Agent Note: Host-discovered skills are read-only package sources

Status: implemented

## Problem

Users already install reusable Agent Skills in standard local folders such as `~/.agents/skills`, `~/.codex/skills`, and `~/.claude/skills`. Requiring a manual copy into Barn's SQLite catalog hides those workflows from the Agent and makes edits in the source folder stale. Barn also needs the supporting files of a skill, not only its `SKILL.md` body.

## Decision

Barn scans a bounded set of standard host roots at startup and on a background refresh. It also resolves skills from enabled Codex plugin manifests and installed Claude plugin manifests. Each discovered folder is a read-only package whose `SKILL.md` metadata is indexed, whose resource paths are bounded to the package, and whose contents are read live on demand.

Discovered skills appear beside built-in and custom skills with their provider label. They default to enabled, can be disabled without changing the source folder, and persist that preference in `skill_preferences`. The Agent receives one bounded `<available_skills>` discovery message per Worker session and can list, read, or read a supporting file through `skill_list`, `skill_read`, and `skill_file`. A catalog revision change rebuilds the Worker session on the next prompt instead of repeating the catalog every turn. Skill text is user-controlled workflow input, never system instructions or permission grants.

The scanner skips platform built-ins such as Codex `skills/.system`, plugin cache without an enabled or installed manifest, generated directories, escaping symlinks, oversized resources, and paths outside a package. It collapses identical copies across providers, keeps same-name skills whose content differs, tolerates individual malformed skills, and reports bounded warnings rather than failing the catalog. Manual rescan and a periodic scan keep source edits visible without copying them into the encrypted custom-skill store.

## Alternatives considered

**Auto-import every discovered skill into SQLite.** Rejected because it duplicates user content, breaks when the source folder changes, and makes remote or shared use look supported when the files remain device-local.

**Scan every directory below the home folder.** Rejected because it is slow, crosses unrelated project boundaries, and turns arbitrary files into model-visible metadata.

**Read only `SKILL.md`.** Rejected because skill packages commonly depend on references, templates, and scripts. The read-only package source preserves those relative paths and can serve them on demand.

**Inject full skill instructions into the system prompt.** Rejected because it burns context for unrelated tasks and elevates user-controlled text above the user's request. Only metadata is listed up front; instructions are read when selected.

## Consequences

- Local skills update from their source without an import step; removing a source removes it after the next scan.
- Enablement is a Barn preference, not an edit to the source package.
- Only the local Barn runtime can use host-discovered skills; they are not part of a cloud or shared catalog.
- Custom Markdown imports remain single-file, encrypted SQLite records. Host-discovered skills support bounded multi-file resources.
- The catalog revision sent to the Worker is a bounded digest, so the number of installed skills does not affect the protocol payload.
- A missing, malformed, oversized, or externally symlinked package may appear as a scan warning instead of a usable skill.
- See [Local skills are explicit, on-demand procedures](2026-11-23-local-skills.md) for the base catalog and tool model.
