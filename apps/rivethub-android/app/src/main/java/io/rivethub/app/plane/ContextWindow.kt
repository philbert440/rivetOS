package io.rivethub.app.plane

import kotlin.math.ceil

/**
 * Model → max context window (tokens), for the header's context-fill bar.
 * Port of `apps/rivethub-web/src/lib/context-window.ts`.
 *
 * Claude Code's real window is 200k (Fable included); the 1M window exists
 * only on the explicit `[1m]` / `-1m` model variant. grok is 500k; Codex /
 * GPT-5-class is 400k. Callers that already have a per-model
 * `contextWindow` must prefer it — this table is the fallback.
 */
private data class WindowMatch(val match: Regex, val tokens: Int)

private val WINDOWS: List<WindowMatch> = listOf(
    WindowMatch(Regex("claude|anthropic|opus|sonnet|haiku|fable", RegexOption.IGNORE_CASE), 200_000),
    WindowMatch(Regex("grok", RegexOption.IGNORE_CASE), 500_000),
    WindowMatch(Regex("^gpt-5|codex", RegexOption.IGNORE_CASE), 400_000),
    WindowMatch(Regex("local|vllm|llama-server|llama_server", RegexOption.IGNORE_CASE), 262_144),
    WindowMatch(Regex("qwen|deepseek|llama|mistral|mixtral|phi-|gemma|yi-|hermes", RegexOption.IGNORE_CASE), 262_144),
    WindowMatch(Regex("gpt-4|gpt4|o1|o3", RegexOption.IGNORE_CASE), 128_000),
)

const val DEFAULT_CONTEXT_WINDOW = 262_144

const val CLAUDE_1M_WINDOW = 1_000_000

/** Explicit opt-in markers for the Claude 1M-window variant. */
private val CLAUDE_1M_MARKERS = listOf("[1m]", "-1m")

/**
 * Tokens reserved below the window for the forced-compaction point — measured
 * 964,285 on a 1M session (~35k reserve). The bar's 100% is compaction, not
 * the raw window.
 */
const val COMPACT_RESERVE = 35_000

fun contextWindowFor(model: String?): Int {
    if (model.isNullOrBlank()) return DEFAULT_CONTEXT_WINDOW
    val lower = model.lowercase()
    if (CLAUDE_1M_MARKERS.any { it in lower }) return CLAUDE_1M_WINDOW
    for (w in WINDOWS) if (w.match.containsMatchIn(model)) return w.tokens
    return DEFAULT_CONTEXT_WINDOW
}

/** Forced-compaction threshold for a window — the context bar's 100%. */
fun compactAtFor(window: Int): Int = window - COMPACT_RESERVE

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
