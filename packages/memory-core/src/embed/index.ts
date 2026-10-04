/**
 * What gets embedded, backend-neutral: how a message's text is composed,
 * how oversized text is chunked and pooled, and what is not worth embedding.
 */

export { splitIntoChunksWithOffsets, meanPool, type TextChunk } from './chunking.js'
export { TOOL_RESULT_EMBED_CAP, composeMessageEmbedText } from './compose-embed-text.js'
export { classifyUnembeddable } from './classify.js'
