package io.rivethub.app.plane

import io.rivethub.app.gateway.MessageUsage
import io.rivethub.app.gateway.WsStatus
import java.util.Locale
import kotlin.math.min
import kotlin.math.roundToInt

/** Phone composer pickers collapse to icon+chevron below this width. */
const val PICKER_COMPACT_MAX_DP = 380f

fun formatCount(n: Int): String = String.format(Locale.US, "%,d", n)

/**
 * Phone context bar model. The desktop caption (`50.2k/1M · 5%`) and the hot
 * colour live on the track that is `hidden sm:block` (context-bar.tsx:44-56),
 * so the phone view carries only what it renders: the percentage.
 */
data class ContextBarView(
    val tokens: Int,
    val max: Int,
    val pct: Int,
    val estimated: Boolean,
)

/**
 * Prefers harness-reported prompt tokens; estimates from transcript texts
 * when usage is missing. Null when there is nothing to show.
 */
fun contextBarView(reported: Int?, model: String?, texts: List<String>): ContextBarView? {
    val fromReport = reported?.takeIf { it > 0 }
    val estimated = fromReport == null
    val tokens = fromReport ?: if (texts.isNotEmpty()) estimatePromptTokens(texts) else 0
    if (tokens <= 0) return null
    val max = contextWindowFor(model)
    val pct = min(100, ((tokens.toDouble() / max) * 100.0).roundToInt())
    return ContextBarView(tokens = tokens, max = max, pct = pct, estimated = estimated)
}

data class StatsLine(
    val promptLabel: String,
    val completionLabel: String,
)

fun statsLineOrNull(usage: MessageUsage?): StatsLine? {
    if (usage == null) return null
    return statsLine(usage.promptTokens, usage.completionTokens, usage.cachedTokens)
}

fun statsLine(
    promptTokens: Int,
    completionTokens: Int,
    cachedTokens: Int,
): StatsLine {
    val prompt = buildString {
        append(formatCount(promptTokens))
        if (cachedTokens > 0) {
            append(" (")
            append(formatCount(cachedTokens))
            append(" cached)")
        }
    }
    return StatsLine(
        promptLabel = prompt,
        completionLabel = formatCount(completionTokens),
    )
}

/** Send arrow is enabled only on an open socket with a body (text or ready chip). */
fun composerCanSend(ws: WsStatus, text: String, hasReadyAttachment: Boolean): Boolean {
    val hasBody = text.trim().isNotEmpty() || hasReadyAttachment
    return ws == WsStatus.OPEN && hasBody
}

/** Stop replaces send only while a turn is in flight AND the gate can interrupt. */
fun composerShowsStop(inFlight: Boolean, canInterrupt: Boolean): Boolean =
    inFlight && canInterrupt

fun pickerRowCompact(widthDp: Float): Boolean = widthDp < PICKER_COMPACT_MAX_DP
