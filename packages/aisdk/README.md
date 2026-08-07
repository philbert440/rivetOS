# @rivetos/aisdk

Provider AI SDK bridge contract between the RivetOS core loop and provider plugins.

## Purpose

`@rivetos/aisdk` defines the `ProviderAiSdkBridge` interface that each provider
plugin implements so the core agent loop can call Vercel AI SDK `streamText`
without knowing provider-specific construction details (model wiring, headers,
conversation ids, tool bridging, etc.).

Provider plugins expose the bridge via the optional `aiSdkBridge` factory on the
`Provider` interface. See `src/bridge.ts` for the full contract.

## Usage

```ts
import type { ProviderAiSdkBridge } from '@rivetos/aisdk'

// Provider plugins implement aiSdkBridge() → ProviderAiSdkBridge
// The core loop consumes the bridge; application code rarely imports this package directly.
```

## License

Apache-2.0
