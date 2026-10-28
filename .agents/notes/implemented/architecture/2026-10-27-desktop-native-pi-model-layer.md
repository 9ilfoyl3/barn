# Agent Note: Desktop owns pi-ai provider configuration and model calls

Status: implemented

## Problem

Barn Desktop needs a Codex-like Agent with low-latency model access, local provider credentials, and configuration owned by the user on the device. Routing interactive model calls through a Barn Cloud gateway couples Desktop model selection to cloud deployment and prevents the provider catalog from being the product surface.

## Decision

Desktop imports the complete `@earendil-works/pi-ai` built-in provider catalog through `builtinModels()` and owns the `Models` collection, credential store, default provider/model selection, and request stream. Credentials are encrypted with Electron `safeStorage`.

The Agent Worker never receives provider credentials. It sends model start requests to the Electron Host, which resolves the selected model, invokes the Desktop-owned `Models.streamSimple()` function, and forwards provider events back to the Worker. Barn Cloud does not proxy interactive model requests.

Desktop also supports locally configured OpenAI-compatible custom providers through `createProvider()`. Provider setup includes a Volcengine Ark Responses API preset, normalizes endpoint URLs, stores the key and sets the default model in one flow, and can run a bounded connection test through the same Host-owned model path. Provider snapshots exposed to the renderer never contain API keys.

Ark uses the standard `openai-responses` protocol. Its request path drops OpenAI-only prompt-cache and store fields before dispatch while preserving model, input, streaming, tools, and output limits.

## Alternatives considered

**Route interactive calls through Barn Cloud Model Gateway.** Rejected because Desktop-owned provider configuration is the chosen product model and the gateway adds an unnecessary dependency to the interactive path.

**Support only one provider.** Rejected because Barn needs a general Desktop Agent, and pi-ai already supplies maintained provider-specific catalogs and protocol adapters.

**Read keys only from environment variables.** Rejected because a packaged Desktop application needs an in-product setup flow and OS-protected credential storage.

**Run provider calls inside the Agent Worker.** Rejected because it would expose decrypted credentials and provider auth state outside the Electron Host boundary.

## Consequences

- all built-in pi-ai providers appear in the Desktop provider catalog;
- credentials remain in the Electron Host;
- model events cross a typed Worker protocol;
- Worker crashes abort outstanding provider streams;
- provider SDK behavior and catalogs remain coupled to the bundled pi-ai version;
- custom provider setup supports quick presets and live connection tests;
- locally stored credentials remain exposed to a compromised Electron Host process.
