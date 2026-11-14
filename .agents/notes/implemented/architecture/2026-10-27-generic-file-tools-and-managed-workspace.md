# Agent Note: the Agent reads arbitrary files through managed generic tools

Status: implemented

## Problem

Office work arrives in mixed and sometimes unexpected document formats. Hard-coding one parser or assuming CSV/XLSX table layouts would make the Agent brittle and force users to preprocess their files.

## Decision

Uploaded files are copied into a per-session managed attachment directory beneath the Desktop workspace. The Agent receives generic `read_file`, `list_dir`, `search_files`, `view_image`, and sandboxed `shell` tools. File format interpretation is left to the model, using text extraction, format-specific shell tools, or image input when the selected model supports it.

All paths are canonicalized and must remain inside managed roots. Sensitive paths are denied. Shell execution remains sandboxed, network-denied, and fail-closed on platforms without an enforcing backend. Images are returned as pi-ai `ImageContent` only to models whose `input` includes `image`.

## Alternatives considered

**Build a fixed CSV/XLSX import parser in the Agent path.** Rejected because the user needs Agent-led handling of mixed documents and multi-row datasets, not a rigid upload schema.

**Read files directly in the Worker.** Rejected because the Worker must not hold OS filesystem authority.

**Pass raw file bytes to the model for every format.** Rejected because binary formats need extraction or rendering and large payloads must remain bounded.

## Consequences

- file types are not restricted by the picker;
- format support depends on available shell tools or model image support;
- the Agent must inspect files before claiming their contents;
- symlink escapes, path traversal, credential paths, and network access remain blocked by Host policy;
- OCR is not part of the current capability set;
- structured drafts derived from files are stored separately as encrypted snapshots.
