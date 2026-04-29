/**
 * Truncate a string to at most `maxLen` UTF-16 code units, but never leave a
 * lone high surrogate at the end. If the truncation would split a surrogate
 * pair, back off by one so we drop the whole emoji/astral-plane character
 * instead of producing invalid UTF-16 (which serializes to invalid JSON per
 * RFC 8259 and is rejected by llama.cpp's nlohmann::json parser with HTTP 500).
 */
export function safeSlice(s, maxLen) {
  if (s.length <= maxLen) return s
  let end = maxLen
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    // Lone high surrogate at the end — drop it
    end -= 1
  }
  return s.slice(0, end)
}
