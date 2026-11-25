# Agent Note: cross-Session memory is encrypted, scoped, and treated as untrusted reference

Status: implemented

## Problem

Barn starts every Session with a fresh model transcript. Users otherwise repeat stable preferences, project conventions, decisions, and prior findings across Sessions. Session history and context compaction preserve one conversation, but do not provide a durable, user-controlled recall layer.

Pi has persistent Sessions and `AGENTS.md` context files, but no separate long-term memory extraction or recall system. Codex Memories separate deterministic instructions from model-generated recall, run extraction asynchronously, keep generated memory local, expose use/generate controls, and redact secrets.

## Decision

Desktop stores memory entries in the encrypted Session database. Each entry has a `global` or canonical-workspace scope, a kind, title, bounded content, tags, pin state, confidence, version, usage metadata, and source Session ids. Workspace identity is an HMAC of the canonical working directory rather than plaintext. Memory payloads use AES-GCM associated with the entry id and version.

Memory writes are explicit Agent calls to `memory_save`; `memory_search` recalls entries, and `memory_forget` archives one entry by id. Upserts use a scoped deduplication key, preserving provenance while incrementing the entry version. Credential-like content is rejected before storage. Active entries are capped by a configurable setting.

Before each prompt, Host retrieves a bounded, query-relevant set of global and current-workspace entries. Worker receives it as JSON inside a `<memory_context>` block explicitly marked as untrusted reference data, not instructions. Memory retrieval failure does not block the user's prompt. The model can search memory when the injected context is insufficient.

Memory is disabled by default. When generation is enabled, a background extractor runs at most every 15 minutes and processes completed, idle Sessions whose last successful extraction is older than the configured idle window. It records the processed Session sequence, retries failures after a six-hour backoff, and persists per-Session use/generate controls. Extraction sends only a recent bounded set of user and assistant text messages to the configured default model; tool results and images are excluded. Returned entries pass the same schema, scope, quota, deduplication, and credential checks as explicit memory writes.

`AGENTS.md`-style deterministic instructions remain the correct place for rules that must always apply; memory is a probabilistic recall aid.

## Alternatives considered

**Add only another Session summary.** Rejected because summaries remain scoped to one conversation and cannot be recalled across unrelated work.

**Store plaintext Markdown memory files.** Rejected because Barn already protects Session and Task payloads with OS-backed encryption; a plaintext memory directory would become the weakest local data store.

**Always inject all memories.** Rejected because it consumes context, increases prompt-injection surface, and makes stale memories dominate. Retrieval is scoped, ranked, deduplicated, and bounded.

**Let the model decide its own authorization to save or forget memories.** Rejected. The Host enforces enablement, quotas, scope, redaction, and schema validation; model tools only request operations.

**Treat memory text as trusted instructions.** Rejected because memory can be stale, incorrect, or contain prompt-injection text. It is labelled as untrusted reference data and cannot override the system prompt or user request.

## Consequences

- memory is available only after the user enables it;
- global memory follows the user across working directories, while workspace memory follows the canonical directory identity;
- credentials are rejected before encryption and should still never be intentionally placed in memory;
- memory content is encrypted at rest but decrypted inside the Host when retrieved;
- deterministic always-on rules belong in `AGENTS.md`, not memory;
- asynchronous extraction runs against the configured model provider only when the user enables generation;
- repeated extraction is avoided by Session sequence tracking, while later turns can produce a new extraction pass;
- user-facing settings and management build on the typed Memory bridge.

## Production memory update

The memory surface now has two complementary layers. `USER.md` and `MEMORY.md` are encrypted, versioned documents edited from Settings; they are injected into every eligible prompt inside a bounded `<memory_context>` block. Within that block `USER.md` is always included first, `MEMORY.md` second, and query-relevant confirmed entries follow in a separate JSON section. The whole block is escaped and marked as untrusted reference data.

Structured entries keep their provenance and candidate lifecycle. Contradictory inferred candidates coexist with the active key instead of overwriting it. Confirming a candidate atomically archives and supersedes the active entry, while rejecting it preserves an audit record. Memory edits use `id + expectedVersion`; omitted fields are preserved, so pin, tags, confidence, and validity are not reset accidentally. Document saves use the same optimistic-concurrency rule and retain prior versions in `memory_document_revisions`.

Extraction failures no longer advance the processed sequence. They only persist the error and retry time, so the same window is retried and cannot be skipped. Confirming a candidate also respects the active-entry quota.

Extraction candidates may cite message-level refs from the bounded transcript. The Host keeps only refs present in that transcript, falling back to the user-message refs when the model omits or fabricates them. Automatic prompt recall applies a minimum relevance threshold, while explicit `memory_search` remains broader. Due `valid_until` entries move to `expired` during extraction maintenance, with their prior content retained in history. Document revisions are readable from Settings and can be restored through the same optimistic-concurrency save path.

The model-facing `memory_save` tool always creates an inferred candidate. Only the user-facing confirmation path can move a candidate into active recall, preventing autonomous model writes from directly polluting long-term memory.
