# Agent Note: Proactive automation defaults to observe mode with attention budgets

Status: implemented

## Problem

Event sources can produce more suggestions than a person can review. Automatically executing every event is unsafe, while showing every observation creates a new source of noise. The agent needs a default that demonstrates initiative without spending the user's attention or changing files.

## Decision

Desktop stores automation settings with three fields:

- mode: `observe` or `active`;
- maximum pending suggestions;
- per-source suggestion cooldown in minutes.

`observe` is the default. New source events are recorded and deduplicated, then become `proposed` Tasks only while the pending suggestion budget allows. The per-source cooldown suppresses follow-on suggestions from a noisy source. `active` skips the proposal stage and creates queued Tasks, which then use the normal Task runner and permission boundaries.

Suppressed events remain in the source event log, so replay does not create duplicates later. Settings are persisted in SQLite and configurable from Local sources. The Source Settings surface explains the distinction between observing and acting.

## Alternatives considered

**Default to active automation.** Rejected because filesystem and schedule events are approximate signals. A person should see the suggestion quality before allowing autonomous execution.

**Show every proposal.** Rejected because an always-on agent must compete for limited human attention and should rather stay quiet.

**Silently drop suppressed events without recording them.** Rejected because the same event would reappear on the next poll and create inconsistent behavior.

**Implement a separate suggestion database.** Rejected because proposed Tasks already have the visibility, actions, and lifecycle needed for review.

## Consequences

- Proactive behavior starts safely in observe mode.
- Users can inspect suggestion quality before switching to active.
- The pending limit and cooldown bound attention cost.
- Active mode still passes through the Task, permission, approval, and outbox boundaries.
- Ranking is currently deterministic by source and arrival; semantic prioritisation remains future work.
