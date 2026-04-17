/**
 * Provider Registrar — dynamically loads and registers LLM providers
 * using the plugin discovery system.
 *
 * No more hardcoded switch statements. Each provider plugin declares
 * itself in its package.json and is discovered at boot.
 */

import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import type { PluginRegistry } from '../discovery.js'
import { logger } from '@rivetos/core'

const log = logger('Boot:Providers')

// ---------------------------------------------------------------------------
// Provider-specific config resolution (env vars, OAuth, etc.)
// ---------------------------------------------------------------------------

interface ResolvedProviderConfig {
  apiKey: string
  [key: string]: unknown
}

function resolveProviderConfig(
  id: string,
  providerConfig: Record<string, unknown>,
): ResolvedProviderConfig {
  const config = { ...providerConfig } as ResolvedProviderConfig

  // Resolve API key from config → env var
  switch (id) {
    case 'anthropic':
      config.apiKey =
        (providerConfig.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
      if (!config.apiKey) {
        log.warn('No Anthropic API key found. Set ANTHROPIC_API_KEY or providers.anthropic.api_key')
      }
      break
    case 'google':
      config.apiKey =
        (providerConfig.api_key as string | undefined) ?? process.env.GOOGLE_API_KEY ?? ''
      break
    case 'xai':
      config.apiKey =
        (providerConfig.api_key as string | undefined) ?? process.env.XAI_API_KEY ?? ''
      break
    case 'ollama':
      // Ollama doesn't need an API key
      config.apiKey = ''
      break
    case 'llama-server':
      // Optional — only set on llama-server via --api-key
      config.apiKey = (providerConfig.api_key as string | undefined) ?? ''
      break
    default:
      // Unknown provider — try the generic pattern
      config.apiKey =
        (providerConfig.api_key as string | undefined) ??
        process.env[`${id.toUpperCase().replace(/-/g, '_')}_API_KEY`] ??
        ''
  }

  return config
}

// ---------------------------------------------------------------------------
// Provider class constructor arg mapping
// ---------------------------------------------------------------------------

function buildProviderArgs(
  id: string,
  config: ResolvedProviderConfig,
  providerConfig: Record<string, unknown>,
): Record<string, unknown> {
  // Map config YAML keys to provider constructor args
  // Common context window fields — passed to all providers
  const contextFields = {
    contextWindow: providerConfig.context_window,
    maxOutputTokens: providerConfig.max_output_tokens,
  }

  switch (id) {
    case 'anthropic':
      return {
        apiKey: config.apiKey,
        model: providerConfig.model,
        maxTokens: providerConfig.max_tokens,
        ...contextFields,
      }
    case 'google':
      return {
        apiKey: config.apiKey,
        model: providerConfig.model,
        maxTokens: providerConfig.max_tokens,
        ...contextFields,
      }
    case 'xai':
      return {
        apiKey: config.apiKey,
        model: providerConfig.model,
        temperature: providerConfig.temperature,
        ...contextFields,
      }
    case 'ollama':
      return {
        baseUrl: providerConfig.base_url,
        model: providerConfig.model,
        numCtx: providerConfig.num_ctx,
        temperature: providerConfig.temperature,
        keepAlive: providerConfig.keep_alive,
        ...contextFields,
      }
    case 'llama-server':
      return {
        baseUrl: providerConfig.base_url,
        apiKey: config.apiKey,
        model: providerConfig.model,
        maxTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        topP: providerConfig.top_p,
        topK: providerConfig.top_k,
        minP: providerConfig.min_p,
        typicalP: providerConfig.typical_p,
        repeatPenalty: providerConfig.repeat_penalty,
        repeatLastN: providerConfig.repeat_last_n,
        presencePenalty: providerConfig.presence_penalty,
        frequencyPenalty: providerConfig.frequency_penalty,
        mirostat: providerConfig.mirostat,
        mirostatTau: providerConfig.mirostat_tau,
        mirostatEta: providerConfig.mirostat_eta,
        seed: providerConfig.seed,
        id,
        name: (providerConfig.name as string | undefined) ?? id,
        ...contextFields,
      }
    default:
      // Pass through all config for unknown providers
      return { apiKey: config.apiKey, ...providerConfig, ...contextFields }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerProviders(
  runtime: Runtime,
  config: RivetConfig,
  registry: PluginRegistry,
): Promise<void> {
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    try {
      const discovered = registry.get('provider', id)
      if (!discovered) {
        log.warn(`Unknown provider: ${id} (not found in plugin registry, skipped)`)
        continue
      }

      // Dynamic import from the discovered package
      const mod = (await import(discovered.packageName)) as Record<string, unknown>

      // Resolve config (API keys, env vars)
      const resolvedConfig = resolveProviderConfig(id, providerConfig)
      const args = buildProviderArgs(id, resolvedConfig, providerConfig)

      // Find the provider class — convention: {Name}Provider export
      const providerClassName = Object.keys(mod).find((key) => key.endsWith('Provider'))
      if (!providerClassName) {
        log.error(`No Provider class found in ${discovered.packageName}`)
        continue
      }

      const ProviderClass = mod[providerClassName] as new (
        args: Record<string, unknown>,
      ) => import('@rivetos/types').Provider
      runtime.registerProvider(new ProviderClass(args))

      log.debug(`Registered provider: ${id} (${discovered.packageName})`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Failed to register provider ${id}: ${message}`)
    }
  }
}
