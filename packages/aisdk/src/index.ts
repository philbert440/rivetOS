/**
 * @rivetos/aisdk — AI SDK ↔ RivetOS adapter helpers.
 *
 * Provider plugins and the core loop share this package for:
 *   - converting RivetOS Message[] ↔ AI SDK ModelMessage[]
 *   - translating AI SDK fullStream parts → RivetOS LLMChunk
 *   - the `ProviderAiSdkBridge` contract that providers implement
 *
 * Tagged `scope:contract` so both `scope:domain` (core) and `scope:adapter`
 * (provider plugins) can depend on it without violating the layering rules.
 */

export type { ProviderAiSdkBridge, GetModelInput } from './bridge.js'
export {
  extractText,
  partsToAiSdkUserContent,
  convertMessagesToAiSdk,
  createLlmChunkAccumulator,
  translateAiSdkPart,
  buildDoneChunk,
} from './stream.js'
export type { AiSdkChunkAccumulator } from './stream.js'
