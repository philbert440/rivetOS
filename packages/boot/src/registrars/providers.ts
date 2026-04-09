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

async function resolveProviderConfig(
  id: string,
  providerConfig: Record<string, unknown>,
): Promise<ResolvedProviderConfig> {
  const config = { ...providerConfig } as ResolvedProviderConfig

  // Resolve API key from config → env var → OAuth (Anthropic-specific)
  switch (id) {
    case 'anthropic': {
      config.apiKey =
        (providerConfig.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
      if (!config.apiKey) {
        try {
          const anthropicPkg = '@rivetos/provider-anthropic'
          const { loadTokens } = (await import(anthropicPkg)) as {
            loadTokens: () => Promise<{ accessToken?: string } | null>
          }
          const tokens = await loadTokens()
          if (tokens?.accessToken) {
            config.apiKey = tokens.accessToken
          }
        } catch {
          /* no OAuth configured */
        }
      }
      if (!config.apiKey) {
        console.warn(
          '[RivetOS] No Anthropic API key or OAuth token found. Run: rivetos anthropic setup',
        )
      }
      break
    }
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
    case 'openai-compat':
    case 'llama-server':
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
    case 'openai-compat':
    case 'llama-server':
      return {
        baseUrl: providerConfig.base_url,
        apiKey: config.apiKey,
        model: providerConfig.model,
        maxTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        topP: providerConfig.top_p,
        repeatPenalty: providerConfig.repeat_penalty,
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
      // Resolve the provider name for discovery lookup
      // "openai-compat" and "llama-server" both map to the openai-compat plugin
      const lookupName = id === 'llama-server' ? 'openai-compat' : id

      const discovered = registry.get('provider', lookupName)
      if (!discovered) {
        log.warn(`Unknown provider: ${id} (not found in plugin registry, skipped)`)
        continue
      }

      // Dynamic import from the discovered package
      const mod = (await import(discovered.packageName)) as Record<string, unknown>

      // Resolve config (API keys, env vars, OAuth)
      const resolvedConfig = await resolveProviderConfig(id, providerConfig)
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
