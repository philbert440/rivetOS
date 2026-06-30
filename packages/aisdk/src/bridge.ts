/**
 * Provider AI SDK bridge — the contract a provider exposes for the AI SDK loop.
 * Lets the loop call `streamText({ model, providerOptions, ... })` directly
 * without knowing about provider-specific construction (xAI conv-id headers,
 * response_id capture, etc.).
 *
 * Provider plugins implement this via the optional `aiSdkBridge` factory on
 * the `Provider` interface.
 */

import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModel, StepResult, ToolSet } from 'ai'
import type { ChatOptions, Message, Tool } from '@rivetos/types'

/** Input to `getModel` — caller-supplied per-call config. */
export interface GetModelInput {
  /** Override the provider's default model for this call. */
  modelOverride?: string
  /** Stable conversation identifier (used by xAI for x-grok-conv-id header). */
  conversationId?: string
  /**
   * Original RivetOS Tool[] with live `execute` closures. Populated by the
   * loop for providers that need direct access (e.g. claude-cli, which spins
   * up an embedded MCP server exposing each tool to the CLI subprocess).
   *
   * HTTP-API providers ignore this — the loop hands tools to `streamText`
   * directly via the `tools` arg, which they receive in `doStream(options)`.
   */
  tools?: Tool[]
  /** Logical agent id — labels per-spawn artifacts in claude-cli's MCP bridge. */
  agentId?: string
}

/**
 * Provider-side AI SDK bridge.
 *
 * Each `aiSdkBridge()` factory call returns a fresh bridge — providers can
 * therefore bake per-call config (conversationId, headers) into the returned
 * `LanguageModelV2` without re-instantiating the provider plugin itself.
 */
export interface ProviderAiSdkBridge {
  /**
   * Returns a `LanguageModel` (V2 or V3) ready for `streamText`. The model
   * has all provider-specific wiring (auth, headers, base URL) baked in.
   */
  getModel(input: GetModelInput): LanguageModel

  /**
   * Per-call providerOptions object passed to `streamText({ providerOptions })`.
   *
   * Reads internal provider state (e.g. xAI `previousResponseId` between steps),
   * turn-level options (`thinking`, `freshConversation`), and the messages
   * themselves (e.g. xAI's `store` flag flips off when messages contain images).
   *
   * Returns the provider-keyed options block (e.g. `{ xai: {...} }`) or
   * `undefined` for stateless providers with nothing to add.
   */
  buildProviderOptions(messages: Message[], options?: ChatOptions): JSONObject | undefined

  /**
   * Optional per-step state capture hook. Called by the loop after every
   * `onStepFinish` so the provider can update internal state (e.g. xAI's
   * `previousResponseId` from `stepResult.providerMetadata.xai.responseId`).
   *
   * No-op for stateless providers — leave undefined.
   */
  captureStepResult?(stepResult: StepResult<ToolSet>, options?: ChatOptions): void

  /**
   * Optional server-side tool set the provider wants automatically merged into
   * `streamText({ tools })`. Used for provider-built-in tools that aren't
   * RivetOS-managed (xAI's web_search, x_search, code_execution; Anthropic's
   * computer_use; etc.). Loop merges these alongside client-side tools.
   *
   * Stateless providers without server-side tools leave undefined.
   */
  getServerSideTools?(): ToolSet

  /**
   * Optional message preprocessing — extract a leading system prompt and/or
   * rewrite mid-conversation system messages. Used by providers with strict
   * chat templates (vLLM/llama-server + Qwen/Llama) where mid-conv system
   * messages must be folded into user `[SYSTEM NOTICE]` content.
   *
   * Loop calls this before passing messages to `streamText`. Returns:
   *   - `system?: string` — passed to `streamText({ system })`
   *   - `messages: Message[]` — passed to `streamText({ messages })` after
   *     core's own conversion to AI SDK shape
   *
   * Default behavior (when undefined) = identity: no system extracted, all
   * messages passed through unchanged.
   */
  prepareMessages?(messages: Message[]): { system?: string; messages: Message[] }
}
