/**
 * What gets embedded, backend-neutral: how a message's text is composed,
 * how oversized text is chunked and pooled, and what is not worth embedding.
 */

export { splitIntoChunksWithOffsets, meanPool, type TextChunk } from './chunking.js'
export { TOOL_RESULT_EMBED_CAP, composeMessageEmbedText } from './compose-embed-text.js'
export { classifyUnembeddable } from './classify.js'
export {
  DEFAULT_EMBED_QUERY_INSTRUCTION,
  EMBED_QUERY_INPUT_MAX,
  DEFAULT_EMBED_TIMEOUT_MS,
  MIN_EMBED_TIMEOUT_MS,
  MAX_EMBED_TIMEOUT_MS,
  normalizeQueryText,
  applyEmbedQueryInstruction,
  clampEmbedTimeoutMs,
  safeSlice,
  isRetryableHttpStatus,
  delayForRetry,
} from './query.js'
