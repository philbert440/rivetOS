/**
 * Shared utilities for channel plugins.
 */

import type { ContentPart, ImagePart } from './message.js';
import type { ToolResult } from './tool.js';

/**
 * Extract the text portion from a message content field.
 * Handles both plain string and ContentPart[] (multimodal) formats.
 */
export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Check if content contains any image parts.
 */
export function hasImages(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return false;
  return content.some((p) => p.type === 'image');
}

/**
 * Split text into chunks respecting a maximum length.
 * Tries to split at paragraph boundaries, then newlines, then hard cut.
 *
 * @param text - Text to split
 * @param maxLength - Platform limit (Telegram: 4096, Discord: 2000)
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph break first
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    // Then single newline
    if (splitAt === -1 || splitAt < maxLength * 0.3) {
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    // Hard cut as last resort
    if (splitAt === -1 || splitAt < maxLength * 0.3) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/**
 * Extract text from a ToolResult (string or ContentPart[]).
 */
export function getToolResultText(result: ToolResult): string {
  if (typeof result === 'string') return result;
  return result
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Extract image parts from a ToolResult.
 * Returns empty array if result is a plain string.
 */
export function getToolResultImages(result: ToolResult): ImagePart[] {
  if (typeof result === 'string') return [];
  return result.filter((p): p is ImagePart => p.type === 'image');
}

/**
 * Check if a ToolResult contains any images.
 */
export function toolResultHasImages(result: ToolResult): boolean {
  if (typeof result === 'string') return false;
  return result.some((p) => p.type === 'image');
}
