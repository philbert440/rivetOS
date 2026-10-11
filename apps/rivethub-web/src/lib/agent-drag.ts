/**
 * Drag payload for a roster agent leaving the sidebar. The rail's reorder
 * drag carries it alongside its own text/plain id, so a drop target outside
 * the rail (an empty thread slot on the canvas) can start a thread with that
 * agent without the rail knowing about it.
 */
export const AGENT_DRAG_MIME = 'application/x-rivethub-agent'

/** Whether a drag carries an agent (types are readable during dragover). */
export function isAgentDrag(types: readonly string[]): boolean {
  return types.includes(AGENT_DRAG_MIME)
}
