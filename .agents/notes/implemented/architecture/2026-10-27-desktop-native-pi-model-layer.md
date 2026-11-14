# Agent Note: Desktop owns pi-ai provider configuration and model calls

Status: implemented

## Problem

Barn Desktop needs a capable personal Agent with low-latency model access, local provider credentials, and configuration owned by the user on the device. Routing interactive model calls through a hosted gateway would couple Desktop model selection to server deployment and prevent the provider catalog from being the product surface.

## Decision

Desktop imports the complete `@earendil-works/pi-ai` built-in provider catalog through `builtinModels()` and owns the `Models` collection, credential store, default provider/model selection, and request stream. Credentials are encrypted with Electron `safeStorage`.

The Agent Worker never receives provider credentials. It sends model start requests to the Electron Host, which resolves the selected model, invokes the Desktop-owned `Models.streamSimple()` function, and forwards provider events back to the Worker. Interactive model requests do not pass through a hosted proxy.

Desktop also supports locally configured OpenAI-compatible custom providers through `createProvider()`. Provider setup includes a Volcengine Ark Responses API preset, normalizes endpoint URLs, stores the key and sets the default model in one flow, and can run a bounded connection test through the same Host-owned model path. Provider snapshots exposed to the renderer never contain API keys.

Model settings carry the selected `defaultReasoningEffort` with the default model. Built-in model effort capabilities come from pi-ai's model `thinkingLevelMap` through `getSupportedThinkingLevels()`; custom models declare their supported effort subset in configuration, which becomes the model's thinking-level map. The Host normalizes the saved effort against the selected model and includes it in the Worker session seed. A changed effort reopens the Worker session with the persisted transcript so the Agent loop applies the new thinking level on its next request. The composer model picker reads only models whose provider currently resolves authentication and writes model/effort choices through the same Host-owned settings path. Every model-settings snapshot refreshes the picker, so provider, model, and effort-capability edits appear without restarting Desktop. The picker opens with its compact Model/Effort menu collapsed, then reveals the adjacent left-side submenu when a first-level row is hovered or focused. Effort selection is a theme-colored point slider that supports click, drag, reset, and keyboard changes.

Ark uses the standard `openai-responses` protocol. Its request path drops OpenAI-only prompt-cache and store fields before dispatch while preserving model, input, streaming, tools, and output limits.

## Alternatives considered

**Route interactive calls through a hosted model gateway.** Rejected because Desktop-owned provider configuration is the chosen product model and a gateway adds an unnecessary dependency to the interactive path.

**Support only one provider.** Rejected because Barn needs a general Desktop Agent, and pi-ai already supplies maintained provider-specific catalogs and protocol adapters.

**Read keys only from environment variables.** Rejected because a packaged Desktop application needs an in-product setup flow and OS-protected credential storage.

**Reuse the provider settings drawer as the composer model picker.** Rejected because provider administration and per-conversation model selection are different tasks; the settings surface exposes unconfigured providers and does not fit the composer interaction.

**Offer every pi-ai thinking level to every custom model.** Rejected because provider and model capabilities differ; accepting an unsupported effort either causes a provider error or silently clamps to another level.

**Run provider calls inside the Agent Worker.** Rejected because it would expose decrypted credentials and provider auth state outside the Electron Host boundary.

## Consequences

- all built-in pi-ai providers appear in the Desktop provider catalog;
- credentials remain in the Electron Host;
- model events cross a typed Worker protocol;
- Worker crashes abort outstanding provider streams;
- provider SDK behavior and catalogs remain coupled to the bundled pi-ai version;
- custom provider setup supports quick presets and live connection tests;
- reasoning effort is persisted with the default model and applied on Agent requests;
- custom reasoning models can expose any supported subset of pi-ai thinking levels;
- changing the effort for an existing session rebuilds the Worker session from persisted messages;
- locally stored credentials remain exposed to a compromised Electron Host process.
