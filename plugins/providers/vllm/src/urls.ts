/**
 * OpenAI-compatible URL surface for the vLLM provider.
 *
 * Chat completions live at `${openaiCompatBaseURL(base, prefix)}/chat/completions`
 * (the AI SDK appends `/chat/completions` to `baseURL`). The models probe
 * lives at `${base}${prefix}/models` unless `models_url` overrides it.
 */

/** Default OpenAI-compat path prefix (vLLM, llama-server-style `/v1`). */
export const DEFAULT_API_PREFIX = '/v1'

/**
 * Normalise `api_prefix`. `undefined`/`null` → `"/v1"`. `""` means no prefix.
 * Non-empty values get a leading slash and trailing slashes stripped.
 */
export function normalizeApiPrefix(apiPrefix: string | undefined | null): string {
  if (apiPrefix == null) return DEFAULT_API_PREFIX
  const trimmed = apiPrefix.trim()
  if (trimmed === '') return ''
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '')
}

/** AI SDK `baseURL`. Equivalent to `${baseUrl}${apiPrefix}`. */
export function openaiCompatBaseURL(baseUrl: string, apiPrefix: string): string {
  return `${baseUrl}${apiPrefix}`
}

/** Full chat-completions URL the AI SDK will hit given that `baseURL`. */
export function chatCompletionsUrl(baseUrl: string, apiPrefix: string): string {
  return `${openaiCompatBaseURL(baseUrl, apiPrefix)}/chat/completions`
}

/**
 * Models probe / discovery URL. An absolute `modelsUrl` wins when set;
 * otherwise `<base><prefix>/models`.
 */
export function modelsProbeUrl(baseUrl: string, apiPrefix: string, modelsUrl?: string): string {
  if (modelsUrl) return modelsUrl
  return `${baseUrl}${apiPrefix}/models`
}
