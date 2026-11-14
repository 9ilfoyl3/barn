# Agent Note: the Agent reads arbitrary files through managed generic tools

Status: implemented

## Problem

Office work arrives in mixed and sometimes unexpected document formats. Hard-coding one parser or assuming CSV/XLSX table layouts would make the Agent brittle and force users to preprocess their files.

## Decision

Uploaded files are copied into a per-session managed attachment directory beneath the Desktop workspace. The Agent receives generic `read_file`, `write_file`, `edit_file`, `list_dir`, `find_files`, `search_files`, `view_image`, and sandboxed `shell` tools. File format interpretation is left to the model, using text extraction, format-specific shell tools, or image input when the selected model supports it.

`find_files` matches relative paths with glob patterns. `search_files` searches UTF-8 content by literal string or regular expression, with optional glob filtering, case folding, context lines, and bounded results. Both walkers skip symlinks, sensitive paths, `.git`, and `node_modules`, and honor `.gitignore` entries at the search root. Content search reads files up to 2MB and caps output at 50KB so one broad query cannot exhaust model context. Directory listing has bounded depth and entry count.

`write_file` creates a UTF-8 file or completely replaces one. `edit_file` applies one or more exact, unique, non-overlapping replacements to an existing UTF-8 file. Both resolve the nearest existing ancestor before writing so a non-existent target cannot escape through a symlinked parent. Writes use a same-directory temporary file and atomic rename, preserve the existing mode, and `edit_file` preserves the original line endings and UTF-8 BOM.

All paths are canonicalized and must remain inside managed roots. Sensitive paths are denied. Shell execution remains sandboxed, network-denied, and fail-closed on platforms without an enforcing backend. Images are returned as pi-ai `ImageContent` only to models whose `input` includes `image`.

## Alternatives considered

**Build a fixed CSV/XLSX import parser in the Agent path.** Rejected because the user needs Agent-led handling of mixed documents and multi-row datasets, not a rigid upload schema.

**Read files directly in the Worker.** Rejected because the Worker must not hold OS filesystem authority.

**Pass raw file bytes to the model for every format.** Rejected because binary formats need extraction or rendering and large payloads must remain bounded.

**Embed the semantic-search embedding index into the base tool path immediately.** Rejected for the baseline because it requires an external embedding provider, durable cache lifecycle, and credential configuration before a first-time user can search. Deterministic local search ships without those prerequisites; semantic retrieval can remain an optional layer over the same bounded file walker.

**Require the Agent to use shell redirection for every file change.** Rejected because shell commands do not provide structured path validation, exact-match checks, or a reliable success result. Dedicated write/edit tools keep the permission boundary and failure behavior explicit.

## Consequences

- file types are not restricted by the picker;
- format support depends on available shell tools or model image support;
- the Agent must inspect files before claiming their contents;
- symlink escapes, path traversal, credential paths, gitignored generated content, and network access remain blocked by Host policy;
- filename and content discovery are local, deterministic, and provider-free; semantic retrieval remains optional and unshipped;
- file changes are structured, bounded, and atomic rather than opaque shell side effects;
- OCR is not part of the current capability set;
- structured drafts derived from files are stored separately as encrypted snapshots.
