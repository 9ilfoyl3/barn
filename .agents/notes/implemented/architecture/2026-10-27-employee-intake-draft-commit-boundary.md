# Agent Note: employee intake drafts stay local until a user commits

Status: implemented

## Problem

The Agent must be able to inspect arbitrary employee documents, produce a batch of employee drafts, and ask follow-up questions. It must not silently create, overwrite, or approve employee records, and large rosters cannot be managed through chat messages alone.

## Decision

Employee intake state is stored locally as encrypted Session snapshots. The Agent receives typed `employee_intake_create`, `employee_intake_get`, `employee_intake_update`, and `employee_intake_preview` tools. It never receives a commit tool.

The renderer displays an intake review panel with employee-level status, grouped issues, field editing, Cloud validation, and a user-triggered commit button. Cloud preview tokens are bound to the exact intake payload hash. A successful commit marks the local intake as committed and records the Cloud employee IDs.

The Agent can propose and correct drafts across multiple turns, but employee creation requires Cloud validation plus an explicit UI action.

## Alternatives considered

**Let the Agent call commit after it believes the draft is ready.** Rejected because document extraction can be wrong and HR creation requires explicit user confirmation.

**Keep drafts only in the model transcript.** Rejected because revisions, field edits, missing-item summaries, and restart recovery need structured state.

**Build a fixed CSV/XLSX parser as the primary intake path.** Rejected because input formats vary and the Agent must handle unstructured and multimodal documents.

## Consequences

- intake snapshots share the encrypted Session durability boundary;
- the UI can edit fields without asking the model to repeat them;
- Cloud validation remains authoritative for required fields and duplicates;
- commit remains impossible through model tool calls;
- employee data in local drafts is sensitive and must remain encrypted at rest.
