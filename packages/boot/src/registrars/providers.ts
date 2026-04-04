/**
 * Provider Registrar — instantiates and registers LLM providers from config.
 */

import type { Runtime } from '@rivetos/core';
import type { RivetConfig } from '../config.js';
import { logger } from '@rivetos/core';

const log = logger('Boot:Providers');

export async function registerProviders(runtime: Runtime, config: RivetConfig): Promise<void> {
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    try {
      switch (id) {
        case 'anthropic': {
          const { AnthropicProvider } = await import('@rivetos/provider-anthropic');
          let apiKey = (providerConfig.api_key as string) ?? process.env.ANTHROPIC_API_KEY ?? '';
          if (!apiKey) {
            try {
              const { loadTokens } = await import('@rivetos/provider-anthropic');
              const tokens = await loadTokens();
              if (tokens?.accessToken) {
                apiKey = tokens.accessToken;
              }
            } catch { /* no OAuth configured */ }
          }
          if (!apiKey) {
            console.warn('[RivetOS] No Anthropic API key or OAuth token found. Run: rivetos anthropic setup');
          }
          runtime.registerProvider(new AnthropicProvider({
            apiKey,
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
          }));
          break;
        }

        case 'google': {
          const { GoogleProvider } = await import('@rivetos/provider-google');
          runtime.registerProvider(new GoogleProvider({
            apiKey: (providerConfig.api_key as string) ?? process.env.GOOGLE_API_KEY ?? '',
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
          }));
          break;
        }

        case 'xai': {
          const { XAIProvider } = await import('@rivetos/provider-xai');
          runtime.registerProvider(new XAIProvider({
            apiKey: (providerConfig.api_key as string) ?? process.env.XAI_API_KEY ?? '',
            model: providerConfig.model as string,
            temperature: providerConfig.temperature as number,
          }));
          break;
        }

        case 'ollama': {
          const { OllamaProvider } = await import('@rivetos/provider-ollama');
          runtime.registerProvider(new OllamaProvider({
            baseUrl: providerConfig.base_url as string,
            model: providerConfig.model as string,
            numCtx: providerConfig.num_ctx as number,
            temperature: providerConfig.temperature as number,
            keepAlive: providerConfig.keep_alive as string,
          }));
          break;
        }

        case 'openai-compat':
        case 'llama-server': {
          const { OpenAICompatProvider } = await import('@rivetos/provider-openai-compat');
          runtime.registerProvider(new OpenAICompatProvider({
            baseUrl: providerConfig.base_url as string,
            apiKey: providerConfig.api_key as string,
            model: providerConfig.model as string,
            maxTokens: providerConfig.max_tokens as number,
            temperature: providerConfig.temperature as number,
            topP: providerConfig.top_p as number,
            repeatPenalty: providerConfig.repeat_penalty as number,
            id,
            name: (providerConfig.name as string) ?? id,
          }));
          break;
        }

        default:
          log.warn(`Unknown provider: ${id} (skipped)`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to register provider ${id}: ${message}`);
    }
  }
}
