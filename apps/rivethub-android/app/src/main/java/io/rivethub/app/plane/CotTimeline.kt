package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Chain-of-thought timeline for one assistant turn (UX-SPEC §1.3): the
 * reasoning step first, then each tool call in order. The assistant text is
 * not a step — it renders below the timeline.
 */
sealed interface CotStep {
    /** [durationMs] is the phone measurement when one exists; [live] = the in-flight turn. */
    data class Reasoning(val text: String, val durationMs: Long?, val live: Boolean) : CotStep

    data class Tool(
        val id: String?,
        val name: String,
        val title: String,
        val status: String,
        val args: JsonObject?,
        val input: JsonElement?,
        val resultText: String?,
        val live: Boolean,
        /** [resultText] is a bounded live preview; the full result is in the committed turn. */
        val resultTruncated: Boolean = false,
    ) : CotStep
}

/**
 * Steps for a stored [turn] (reasoning from `thinking`, then its tools) or,
 * when [live], for the in-flight slot ([liveReasoning] + [liveTools]; [turn]
 * is ignored). Blank reasoning yields no reasoning step.
 */
fun cotSteps(
    turn: HarnessTranscriptTurn?,
    liveReasoning: String,
    liveTools: List<LiveTool>,
    reasoningDurationMs: Long?,
    live: Boolean,
): List<CotStep> {
    val out = ArrayList<CotStep>()
    if (live) {
        if (liveReasoning.isNotBlank()) out += CotStep.Reasoning(liveReasoning, reasoningDurationMs, live = true)
        for (t in liveTools) {
            val obj = t.args as? JsonObject
            out += CotStep.Tool(
                id = t.id,
                name = t.name,
                title = humanToolTitle(t.name, toolArgStrings(obj)),
                status = t.status,
                args = obj,
                input = t.args,
                resultText = t.resultPreview,
                live = true,
                resultTruncated = t.resultTruncated,
            )
        }
        return out
    }
    if (turn == null) return out
    val thinking = turn.thinking
    if (!thinking.isNullOrBlank()) out += CotStep.Reasoning(thinking, reasoningDurationMs, live = false)
    for (t in turn.tools.orEmpty()) {
        val obj = t.args ?: (t.input as? JsonObject)
        out += CotStep.Tool(
            id = t.id,
            name = t.name,
            title = humanToolTitle(t.name, toolArgStrings(obj)),
            status = t.status,
            args = t.args,
            input = t.input,
            resultText = t.resultText,
            live = false,
        )
    }
    return out
}

data class CotFold(val visible: List<CotStep>, val hiddenCount: Int)

/** Collapsed: the last [keepLast] steps plus how many sit above them. Expanded: everything. */
fun foldSteps(steps: List<CotStep>, expanded: Boolean, keepLast: Int = 2): CotFold {
    val keep = keepLast.coerceAtLeast(0)
    if (expanded || steps.size <= keep) return CotFold(steps, 0)
    return CotFold(steps.takeLast(keep), steps.size - keep)
}

/** The "collapse" affordance shows only on an expanded timeline that has something to fold. */
fun showCollapse(stepCount: Int, expanded: Boolean, keepLast: Int = 2): Boolean =
    expanded && stepCount > keepLast.coerceAtLeast(0)

/** Theme-token key for a step's rail dot: `em` running, `red` error, `inkDim` otherwise. */
fun stepDotColorKey(status: String): String = when (status) {
    "running" -> "em"
    "error" -> "red"
    else -> "inkDim"
}

/**
 * Loading-row text while a turn is in flight: the human title of the newest
 * running tool, else the agent status line. Null → the caller's generic
 * "working" copy.
 */
fun loadingLabel(steps: List<CotStep>, agentStatusText: String?): String? {
    val running = steps.filterIsInstance<CotStep.Tool>().lastOrNull { it.status == "running" }
    return running?.title ?: agentStatusText?.takeIf { it.isNotBlank() }
}

private val PRETTY_JSON = Json { prettyPrint = true }

/** Pretty-printed JSON, or null for a missing / JSON-null element. */
fun prettyJson(el: JsonElement?): String? {
    if (el == null || el is JsonNull) return null
    return PRETTY_JSON.encodeToString(JsonElement.serializer(), el)
}

/** The tool-sheet "Arguments" block: `args`, else the raw `input`. */
fun toolArgsText(step: CotStep.Tool): String? = prettyJson(step.args ?: step.input)

/**
 * Text form of a live tool result: a string is shown as-is, an array of
 * `{text}` content blocks is joined, anything else is pretty JSON.
 */
fun toolResultText(output: JsonElement?): String? {
    if (output == null || output is JsonNull) return null
    if (output is JsonPrimitive) {
        return if (output.isString) output.content else output.contentOrNull
    }
    if (output is JsonArray && output.isNotEmpty()) {
        val parts = output.map { el ->
            ((el as? JsonObject)?.get("text") as? JsonPrimitive)?.takeIf { it.isString }?.content
        }
        if (parts.all { it != null }) return parts.joinToString("\n")
    }
    return prettyJson(output)
}

/** Chars of a live tool result kept in memory (about 4 KB of text). */
const val LIVE_RESULT_PREVIEW_MAX: Int = 4_096

/** A bounded result preview: at most [max] chars, and whether anything was cut. */
data class BoundedResult(val text: String, val truncated: Boolean)

fun boundedResult(text: String?, max: Int = LIVE_RESULT_PREVIEW_MAX): BoundedResult? {
    if (text == null) return null
    val cap = max.coerceAtLeast(0)
    return if (text.length <= cap) BoundedResult(text, false) else BoundedResult(text.take(cap), true)
}

/**
 * Renders a live tool result once, at ingestion, straight to a bounded
 * preview. The raw JSON is dropped by the caller.
 */
fun liveResultPreview(output: JsonElement?, max: Int = LIVE_RESULT_PREVIEW_MAX): BoundedResult? =
    boundedResult(toolResultText(output), max)

/** Display cap for a sheet block; Copy still copies the full text. */
const val SHEET_PREVIEW_MAX: Int = 20_000

fun sheetPreview(text: String, max: Int = SHEET_PREVIEW_MAX): String =
    if (text.length <= max) text else text.take(max) + "\n…"
