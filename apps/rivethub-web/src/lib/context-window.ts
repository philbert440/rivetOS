/**
 * Model → max context window (tokens), for the header's context-fill bar.
 * Matched by substring on the model / agent / harness id so variants resolve
 * without an exact entry.
 *
 * Mesh defaults (2026-07): Claude Code 1M, grok Build 500k, local 262_144.
 */
const WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  // Claude Code / Anthropic — 1M context on current mesh deploys
  { match: /claude|anthropic|opus|sonnet|haiku/i, tokens: 1_000_000 },
  // xAI grok family (API + Build harness ids)
  { match: /grok/i, tokens: 500_000 },
  // Local node / llama-server / vllm — 256k natively (262_144)
  { match: /local|vllm|llama-server|llama_server/i, tokens: 262_144 },
  // Other open-weight families commonly served locally at 256k
  { match: /qwen|deepseek|llama|mistral|mixtral|phi-|gemma|yi-|hermes|fable/i, tokens: 262_144 },
  { match: /gpt-4|gpt4|o1|o3/i, tokens: 128_000 },
]

/** When model is unknown, prefer local window over the old 200k Claude default. */
const DEFAULT_WINDOW = 262_144

/** Max context window for a model id; DEFAULT_WINDOW when unknown. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_WINDOW
  for (const w of WINDOWS) if (w.match.test(model)) return w.tokens
  return DEFAULT_WINDOW
}

/** Compact token count: 18_432 → "18.4k", 1_000_000 → "1M", 262_144 → "262k". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/**
 * Rough chars÷4 estimate when the harness didn't report usage (grok Build,
 * most local models). Matches core's estimateTokens baseline for text-only
 * turns — good enough for a header fill bar, not for billing.
 */
export function estimatePromptTokens(texts: string[]): number {
  let total = 0
  for (const t of texts) {
    total += 4 // role + framing overhead
    total += Math.ceil(t.length / 4)
  }
  return total
}
