/**
 * Shared utilities for channel plugins.
 */

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
