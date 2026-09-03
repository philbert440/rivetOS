package io.rivethub.app.plane

import io.rivethub.app.gateway.MessageUsage
import io.rivethub.app.gateway.WsStatus
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.min
import kotlin.math.roundToInt

/** Phone composer pickers collapse to icon+chevron below this width. */
const val PICKER_COMPACT_MAX_DP = 380f

/** Time-only stamp; ts 0 (lost on backfill) shows nothing rather than 1970. */
fun stamp(ts: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.US): String? {
    if (ts <= 0L) return null
    val z = Instant.ofEpochMilli(ts).atZone(zone)
    return DateTimeFormatter.ofPattern("hh:mm a", locale).format(z)
}

fun formatCount(n: Int): String = String.format(Locale.US, "%,d", n)

data class ContextBarView(
    val tokens: Int,
    val max: Int,
    val pct: Int,
    val hot: Boolean,
    val estimated: Boolean,
) {
    val caption: String
        get() = buildString {
            if (estimated) append('~')
            append(compactTokens(tokens))
            append('/')
            append(compactTokens(max))
            append(" · ")
            append(pct)
            append('%')
            if (estimated) append(" est.")
        }

    val pctLabel: String get() = "$pct%"
}

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
    return ContextBarView(tokens = tokens, max = max, pct = pct, hot = pct >= 85, estimated = estimated)
}

data class StatsLine(
    val promptLabel: String,
    val completionLabel: String,
    val tpsLabel: String?,
    val durationLabel: String?,
)

fun statsLineOrNull(usage: MessageUsage?, durationMs: Long?): StatsLine? {
    if (usage == null) return null
    return statsLine(usage.promptTokens, usage.completionTokens, usage.cachedTokens, durationMs)
}

fun statsLine(
    promptTokens: Int,
    completionTokens: Int,
    cachedTokens: Int,
    durationMs: Long?,
): StatsLine {
    val prompt = buildString {
        append(formatCount(promptTokens))
        if (cachedTokens > 0) {
            append(" (")
            append(formatCount(cachedTokens))
            append(" cached)")
        }
    }
    val secs = if (durationMs != null && durationMs > 0L) durationMs / 1000.0 else 0.0
    val tps = if (secs > 0.0 && completionTokens > 0) completionTokens / secs else 0.0
    return StatsLine(
        promptLabel = prompt,
        completionLabel = formatCount(completionTokens),
        tpsLabel = if (tps > 0.0) String.format(Locale.US, "%.1f tok/s", tps) else null,
        durationLabel = if (secs > 0.0) String.format(Locale.US, "%.1fs", secs) else null,
    )
}

/** Send arrow is enabled only on an open socket with a body (text or ready chip). */
fun composerCanSend(ws: WsStatus, text: String, hasReadyAttachment: Boolean): Boolean {
    val hasBody = text.trim().isNotEmpty() || hasReadyAttachment
    return ws == WsStatus.OPEN && hasBody
}

fun pickerRowCompact(widthDp: Float): Boolean = widthDp < PICKER_COMPACT_MAX_DP
