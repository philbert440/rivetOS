/**
 * Shared utilities for channel plugins.
 */

import type { ContentPart, ImagePart } from './message.js'
import type { ToolResult } from './tool.js'

/**
 * Check if content contains any image parts.
 */
export function hasImages(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return false
  return content.some((p) => p.type === 'image')
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a ToolResult (string or ContentPart[]).
 */
export function getToolResultText(result: ToolResult): string {
  if (typeof result === 'string') return result
  return result
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * Extract image parts from a ToolResult.
 * Returns empty array if result is a plain string.
 */
export function getToolResultImages(result: ToolResult): ImagePart[] {
  if (typeof result === 'string') return []
  return result.filter((p): p is ImagePart => p.type === 'image')
}

/**
 * Check if a ToolResult contains any images.
 */
export function toolResultHasImages(result: ToolResult): boolean {
  if (typeof result === 'string') return false
  return result.some((p) => p.type === 'image')
}
