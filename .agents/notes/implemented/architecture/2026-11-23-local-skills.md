# Agent Note: Local skills are explicit, on-demand procedures

Status: implemented

## Problem

Barn needed a Skills surface beside Plugins and a real execution path. Putting every reusable procedure into the system prompt would grow context for every task and blur the boundary between user-visible capabilities and hidden prompt text. Treating skills as tools would also confuse instructions with executable capabilities.

## Decision

Skills are reusable procedures represented by name, description, source, enabled state, and Markdown instructions. The built-in catalog provides read-only system skills. Custom skills are stored in SQLite with encrypted instruction content; names and descriptions remain non-secret list metadata. Custom skills can be created, edited, enabled or disabled, deleted, and imported from a Markdown file with optional name/description frontmatter.

The Plugins page exposes a Skills tab with search, All/System/Custom filters, a skill list, a rendered instruction detail dialog, create/edit forms, import, copy, enable/disable, and delete. System skills cannot be edited or deleted and are always enabled.

The Worker receives two stable tools: `skill_list` returns only enabled skill summaries, and `skill_read` returns the full instructions for one enabled skill. The system prompt tells the Agent to list skills when a reusable procedure may apply and read the selected skill before using it. Skill instructions are not automatically injected into every prompt.

## Alternatives considered

**Inject all enabled skills into every system prompt.** Rejected because it consumes context for unrelated tasks and makes skill changes silently alter all conversations.

**Expose each skill as a Worker tool.** Rejected because skills are instructions, not executable capabilities, and a dynamic tool schema would conflate the two concepts.

**Store custom skill instructions as plain list metadata.** Rejected because skill files can contain sensitive internal procedures. Only summaries are returned to list callers; full instructions are encrypted at rest and read on demand.

**Make system skills editable.** Rejected for the first slice because they are shipped product assets and need stable upgrade behavior. Teams can copy their procedure into a custom skill instead.

## Consequences

- The Agent can discover and apply skills without paying their full context cost on every request.
- Disabling a custom skill removes it from `skill_list` and blocks `skill_read`.
- System skills remain available and read-only across upgrades.
- Markdown import supports the conventional `SKILL.md` shape but currently stores the instructions in SQLite rather than a filesystem package.
- Multi-file skill packages and executable skill scripts remain future work.
