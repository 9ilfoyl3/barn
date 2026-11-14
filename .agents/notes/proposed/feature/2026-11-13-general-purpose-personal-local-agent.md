# Agent Note: Barn Desktop targets general-purpose personal office work

Status: proposed

## Problem

The current product framing reads as a single-profession enterprise workspace. That narrows the audience, makes the first-run experience assume specialist knowledge, and ties the core experience to a hosted control plane. It does not match the intended product: a personal local Agent that ordinary users can adopt without learning Agent concepts.

## Proposal

Barn Desktop becomes a general-purpose, local-first personal Agent for everyday office work. The product serves users with no prior Agent experience and makes the common path simple, direct, and safe.

The product should:

- use plain-language setup and role-neutral task entry;
- provide sensible defaults without exposing prompts, tools, models, or Agent loops as prerequisites;
- complete common office tasks such as document summarization, writing, spreadsheet analysis, data extraction, report preparation, meeting notes, file organization, research synthesis, and repetitive workflows;
- keep local files, Session history, model credentials, and core execution on the user's device;
- explain consequential actions and require understandable confirmation before external writes or destructive operations;
- reveal advanced model, tool, and workspace controls progressively rather than making them part of onboarding.

The core product must not require a hosted control plane, hosted account, or hosted data service. Individual model providers may still be remote services selected and configured by the user.

The legacy role-specific product surface, hosted authentication path, and related business modules have been removed from Desktop. Future work should build only on the general agent shell.

The next development direction remains intentionally open. This note fixes the product frame, not a feature roadmap or implementation sequence.

## Alternatives considered

**Keep a profession-specific enterprise workspace.** Rejected because it limits the addressable audience and forces product complexity that most personal office users do not need.

**Build only for experienced Agent users.** Rejected because prompt engineering, tool selection, and model configuration knowledge would remain prerequisites for doing useful work.

**Require a hosted account and control plane.** Rejected because it conflicts with the local-first personal product, adds account and availability dependencies, and weakens the promise that the core experience runs on the user's device.

**Expose every model and tool control on the main surface.** Rejected because expert flexibility would dominate first-run usability. Advanced controls should be available progressively after the common path works.

## Acceptance criteria

- Product documentation and onboarding use role-neutral office language.
- A first-time user can complete a useful office task without understanding Agents, models, prompts, or tools.
- The default setup path requires only the minimum information needed to connect a model provider and begin.
- Common office formats and workflows can be handled from a natural-language request without manual tool assembly.
- Advanced model, workspace, and execution controls remain available without occupying the primary novice flow.
- The core experience works locally and does not require a hosted account or control plane.
- Consequential actions have clear explanations, visible state, and explicit confirmation where appropriate.

## Risks

- Broad positioning can dilute focus; the roadmap should prioritize a small set of high-frequency office jobs.
- Strong defaults can obscure important behavior; the UI still needs transparent status and recoverable actions.
- Provider setup and local capability support vary across machines, so failure states must be understandable and actionable.
- A general Agent can reach more sensitive local data and external actions; sandboxing and confirmation boundaries must scale with that reach.
