/**
 * Model → max context window (tokens), for the header's context-fill bar.
 * Matched by substring on the model / agent / harness id so variants resolve
 * without an exact entry.
 *
 * Claude Code is 200k by default; 1M only when the id carries `[1m]` / `-1m`.
 * grok Build is 500k; local/vllm is 262_144.
 */
const WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  // Claude 1M variant — request-side flag, not a transcript model id
  { match: /\[1m\]|-1m/i, tokens: 1_000_000 },
  // Claude Code / Anthropic — 200k default (the 1M regex above wins)
  { match: /claude|anthropic|opus|sonnet|haiku|fable/i, tokens: 200_000 },
  // xAI grok family (API + Build harness ids)
  { match: /grok/i, tokens: 500_000 },
  // Local node / llama-server / vllm — 256k natively (262_144)
  { match: /local|vllm|llama-server|llama_server/i, tokens: 262_144 },
  // Other open-weight families commonly served locally at 256k
  { match: /qwen|deepseek|llama|mistral|mixtral|phi-|gemma|yi-|hermes/i, tokens: 262_144 },
  { match: /gpt-4|gpt4|o1|o3/i, tokens: 128_000 },
]

/** Context window when the model is unknown. */
const DEFAULT_WINDOW = 262_144

/**
 * Tokens held back from the advertised window before Claude Code force-compacts.
 * Measured on a 1M session (compacted at 964,285 ≈ window − 35k). The 200k
 * threshold is provisional (same reserve) until a session self-calibrates.
 */
export const COMPACT_RESERVE = 35_000

/** Max context window for a model id; DEFAULT_WINDOW when unknown. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return DEFAULT_WINDOW
  for (const w of WINDOWS) if (w.match.test(model)) return w.tokens
  return DEFAULT_WINDOW
}

/** Forced-compaction threshold — the bar's 100%. */
export function compactAtFor(window: number): number {
  if (!Number.isFinite(window) || window <= 0) return 1
  return Math.max(1, window - COMPACT_RESERVE)
}

/**
 * Fill toward forced compaction. `pct` is tokens/compactAt, clamped 0–100.
 * `warn` ≥ 70%, `hot` ≥ 90%.
 */
export function contextFill(args: { tokens: number; contextWindow: number; compactAt?: number }): {
  pct: number
  hot: boolean
  warn: boolean
} {
  const compactAt =
    args.compactAt && args.compactAt > 0 ? args.compactAt : compactAtFor(args.contextWindow)
  const raw = compactAt > 0 ? args.tokens / compactAt : 0
  const pct = Math.min(100, Math.max(0, Math.round(raw * 100)))
  return { pct, warn: pct >= 70, hot: pct >= 90 }
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
