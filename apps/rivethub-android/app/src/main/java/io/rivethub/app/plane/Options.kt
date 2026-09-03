package io.rivethub.app.plane

import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.HarnessCapabilities
import io.rivethub.app.gateway.ModelOption

/** Slice of a capability sheet the pickers and spawn flags need. */
data class HarnessSheet(
    val models: List<ModelOption>? = null,
    val efforts: List<EffortOption>? = null,
    val modelFlag: String? = null,
    val effortFlag: String? = null,
)

fun HarnessCapabilities.toSheet(): HarnessSheet = HarnessSheet(models, efforts, modelFlag, effortFlag)

private val HARNESS_LABEL: Map<String, String> = mapOf(
    "claude-code" to "Claude Code",
    "grok-build" to "grok Build",
    "kimi-code" to "Kimi Code",
    "hermes" to "Hermes",
    "deepseek-harness" to "DeepSeek",
)

fun harnessLabel(harnessId: String?): String {
    if (harnessId.isNullOrBlank()) return ""
    return HARNESS_LABEL[harnessId] ?: harnessId
}

/**
 * Conversation-row pill: session summary model, else the preset's model,
 * else the harness label.
 */
fun rowPillText(summaryModel: String?, presetModel: String?, harnessId: String?): String {
    val fromSummary = summaryModel?.trim().orEmpty()
    if (fromSummary.isNotEmpty()) return fromSummary
    val fromPreset = presetModel?.trim().orEmpty()
    if (fromPreset.isNotEmpty()) return fromPreset
    return harnessLabel(harnessId)
}

data class SpawnFlags(val model: String? = null, val effort: String? = null) {
    fun isEmpty(): Boolean = model == null && effort == null
}

/**
 * Flags to send on spawn. Empty without a harnessId (catalog chat-loop
 * threads must not inherit `--effort medium`). Model/effort are included
 * only when the sheet declares the matching flag — unknown harness or a
 * sheet with neither flag → empty. Matches den-server sheetForHarness
 * spawn, slightly stricter than the web helper which always forwards
 * model/effort when harnessId is set.
 */
fun spawnModelEffort(
    sheet: HarnessSheet?,
    harnessId: String? = null,
    model: String? = null,
    effort: String? = null,
): SpawnFlags {
    if (harnessId.isNullOrBlank() || sheet == null) return SpawnFlags()
    val modelOut = model?.trim()?.takeIf { it.isNotEmpty() }?.takeIf { !sheet.modelFlag.isNullOrBlank() }
    val effortRaw = effort?.trim()?.takeIf { it.isNotEmpty() && it != "off" }
    val effortOut = effortRaw?.takeIf { !sheet.effortFlag.isNullOrBlank() }
    return SpawnFlags(model = modelOut, effort = effortOut)
}

fun defaultModel(sheet: HarnessSheet?): String {
    val models = sheet?.models ?: emptyList()
    return models.find { it.default }?.id ?: models.firstOrNull()?.id ?: ""
}

fun effortListFor(sheet: HarnessSheet?, modelId: String): List<EffortOption> {
    val model = sheet?.models?.find { it.id == modelId }
    return model?.efforts ?: sheet?.efforts ?: emptyList()
}

fun defaultEffort(sheet: HarnessSheet?, modelId: String): String {
    val efforts = effortListFor(sheet, modelId)
    return efforts.find { it.default }?.id ?: efforts.firstOrNull()?.id ?: ""
}
