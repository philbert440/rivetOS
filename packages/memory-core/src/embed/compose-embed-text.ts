/**
 * Build the text that gets embedded for a ros_messages row.
 *
 * Tool rows store the real payload in `tool_result` while `content` is often a
 * short placeholder like `[tool] run_terminal_command`. FTS already indexes both
 * (migration 0008); the vector arm used to embed `content` alone, so hybrid
 * search missed the high-value tool payloads on the semantic path.
 *
 * Summaries / wiki topics have no tool_result — callers pass content only.
 */

/** Cap tool_result contribution so a single huge payload does not dominate the
 *  embed request. Matches the FTS tool_result cap spirit (0008 uses 32k). */
export const TOOL_RESULT_EMBED_CAP = 32_768

/**
 * Compose content + optional tool_result for embedding.
 * Returns empty string when both sides are blank after trim.
 */
export function composeMessageEmbedText(
  content: string | null | undefined,
  toolResult: string | null | undefined,
): string {
  const c = typeof content === 'string' ? content.trim() : ''
  const rawT = typeof toolResult === 'string' ? toolResult.trim() : ''
  const t =
    rawT.length > TOOL_RESULT_EMBED_CAP ? rawT.slice(0, TOOL_RESULT_EMBED_CAP) : rawT
  if (!c) return t
  if (!t) return c
  return `${c}\n${t}`
}
