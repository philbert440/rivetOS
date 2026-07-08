/**
 * Model → max context window (tokens), for the header's context-fill bar.
 * Matched by substring on the model id so variants resolve without an exact
 * entry. The `[1m]` long-context variants aren't distinguishable from the model
 * id alone (they're a launch flag), so we default to the standard window; a
 * node that runs the 1M variant can be handled by adding an override.
 */
const WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  { match: /fable/i, tokens: 1_000_000 },
  { match: /opus/i, tokens: 200_000 },
  { match: /sonnet/i, tokens: 200_000 },
  { match: /haiku/i, tokens: 200_000 },
  { match: /gpt-4|gpt4/i, tokens: 128_000 },
  { match: /grok/i, tokens: 256_000 },
]

const DEFAULT_WINDOW = 200_000

/** Max context window for a model id; DEFAULT_WINDOW when unknown. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_WINDOW
  for (const w of WINDOWS) if (w.match.test(model)) return w.tokens
  return DEFAULT_WINDOW
}

/** Compact token count: 18_432 → "18.4k", 1_000_000 → "1M". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}
