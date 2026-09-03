package io.rivethub.app.plane

import java.util.Locale
import kotlin.math.ceil

/**
 * Model → max context window (tokens), for the header's context-fill bar.
 * Port of `apps/rivethub-web/src/lib/context-window.ts`.
 */
private data class WindowMatch(val match: Regex, val tokens: Int)

private val WINDOWS: List<WindowMatch> = listOf(
    WindowMatch(Regex("claude|anthropic|opus|sonnet|haiku", RegexOption.IGNORE_CASE), 1_000_000),
    WindowMatch(Regex("grok", RegexOption.IGNORE_CASE), 500_000),
    WindowMatch(Regex("local|vllm|llama-server|llama_server", RegexOption.IGNORE_CASE), 262_144),
    WindowMatch(Regex("qwen|deepseek|llama|mistral|mixtral|phi-|gemma|yi-|hermes|fable", RegexOption.IGNORE_CASE), 262_144),
    WindowMatch(Regex("gpt-4|gpt4|o1|o3", RegexOption.IGNORE_CASE), 128_000),
)

const val DEFAULT_CONTEXT_WINDOW = 262_144

fun contextWindowFor(model: String?): Int {
    if (model.isNullOrBlank()) return DEFAULT_CONTEXT_WINDOW
    for (w in WINDOWS) if (w.match.containsMatchIn(model)) return w.tokens
    return DEFAULT_CONTEXT_WINDOW
}

/** Compact token count: 18_432 → "18.4k", 1_000_000 → "1M", 262_144 → "262k". */
fun compactTokens(n: Int): String {
    if (n >= 1_000_000) {
        return if (n % 1_000_000 == 0) "${n / 1_000_000}M"
        else String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    }
    if (n >= 1_000) {
        return if (n >= 100_000) String.format(Locale.US, "%.0fk", n / 1_000.0)
        else String.format(Locale.US, "%.1fk", n / 1_000.0)
    }
    return n.toString()
}

/**
 * Rough chars÷4 estimate when the harness didn't report usage.
 * 4 framing tokens per text plus ceil(chars / 4).
 */
fun estimatePromptTokens(texts: List<String>): Int {
    var total = 0
    for (t in texts) {
        total += 4
        total += ceil(t.length / 4.0).toInt()
    }
    return total
}
