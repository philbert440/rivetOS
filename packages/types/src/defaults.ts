/**
 * Default model identifiers for each provider.
 *
 * Single source of truth — when models change, update here only.
 * Provider plugins, tests, and tooling all import from this file.
 */
export const MODEL_DEFAULTS = {
  anthropic: 'claude-opus-4-7',
  xai: 'grok-4.20-reasoning',
  google: 'gemini-2.5-pro',
  ollama: 'llama3.1',
  'llama-server': 'default',
} as const

export type ProviderName = keyof typeof MODEL_DEFAULTS
