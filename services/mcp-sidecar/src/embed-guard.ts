/**
 * Boot-time embed config check for the MCP sidecar.
 *
 * Embed URL without a model is only fatal when Postgres memory is actually
 * being enabled. A stray embed URL with memory disabled must not kill the
 * rest of the MCP server (non-memory tools).
 */

export const EMBED_MODEL_REQUIRED =
  'RIVETOS_EMBED_MODEL is required when RIVETOS_EMBED_URL is set. OpenAI-compatible embedding model id (example: text-embedding-3-small)'

export function memoryEmbedGuardError(
  pgUrl: string | undefined,
  embedUrl: string | undefined,
  embedModel: string | undefined,
): string | null {
  if (!pgUrl) return null
  if (embedUrl && !embedModel) return EMBED_MODEL_REQUIRED
  return null
}
