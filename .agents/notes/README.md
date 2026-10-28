# Barn Desktop Agent Notes

Agent Notes record durable decisions that code and package documentation cannot carry: the problem, the chosen mechanism, rejected alternatives, consequences, and remaining risks.

## Layout

Every note uses `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`.

Lifecycle:

- `proposed/`: reviewed proposal not fully shipped.
- `implemented/`: shipped decision, kept current with the code.
- `rejected/`: declined proposal retained only while its rationale prevents a meaningful mistake.

Class:

- `feature`
- `bug-fix`
- `simplification`
- `architecture`
- `process`
- `testing`

Do not create an index. Search the tree.

## When To Write

Write a note for a lasting decision about Desktop architecture, model providers, credentials, Agent lifecycle, sandboxing, persistence, protocol, or security. Local presentation and mechanical edits are exempt.

Before writing, search for an existing owner. Update that note rather than duplicating the decision. A note never changes into a different decision; supersede it and cross-link both notes.

## File Format

The first three lines are exact:

```markdown
# Agent Note: <title>

Status: proposed
```

The status must match the lifecycle folder: `proposed`, `implemented`, or `rejected - <reason>`.

Proposed notes contain:

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

Implemented notes contain:

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

Every note records real alternatives and why they lost. Facts use present tense once implemented.
