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
    val turnOptions: Boolean = false,
    val imageAttachments: Boolean = false,
)

fun HarnessCapabilities.toSheet(): HarnessSheet =
    HarnessSheet(models, efforts, modelFlag, effortFlag, turnOptions, imageAttachments)

/** Protocol-owned native catalog. Absent unless the session is already bound to protocol. */
fun nativeTurnModels(sheet: HarnessSheet?, transport: String?): List<ModelOption> {
    if (sheet?.turnOptions != true) return emptyList()
    if (transport != "protocol") return emptyList()
    return sheet.models.orEmpty()
}

fun nativeImageAttachments(sheet: HarnessSheet?, transport: String?): Boolean =
    sheet?.imageAttachments == true && transport == "protocol"

/** PNG / JPEG / WebP / GIF — the den's native image allowlist. */
val NATIVE_IMAGE_MIMES: Set<String> = setOf(
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
)

fun isNativeImageMime(mime: String?): Boolean {
    val m = mime?.trim()?.lowercase() ?: return false
    return m in NATIVE_IMAGE_MIMES
}

fun modelAcceptsImage(model: ModelOption?): Boolean {
    val mods = model?.inputModalities ?: return false
    if (mods.isEmpty()) return false
    return mods.any { it.equals("image", ignoreCase = true) }
}

private val HARNESS_LABEL: Map<String, String> = mapOf(
    "claude-code" to "Claude Code",
    "grok-build" to "grok Build",
    "kimi-code" to "Kimi Code",
    "hermes" to "Hermes",
    "deepseek-harness" to "DeepSeek",
    "codex" to "Codex",
    "pi" to "pi",
)

/** Client-side Codex sheet — same lists as den `codexSheet()` (no spawn flags). */
fun codexSheet(): HarnessSheet = HarnessSheet(
    models = listOf(ModelOption("default", "Default", default = true)),
    efforts = listOf(
        EffortOption("low", "Low"),
        EffortOption("medium", "Medium", default = true),
        EffortOption("high", "High"),
        EffortOption("xhigh", "X-High"),
    ),
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
 * only when the sheet declares the matching flag AND the value is a listed
 * id — unknown harness, unlisted id, or a sheet with neither flag → empty.
 * Matches den-server `spawnArgv` (flag present AND listed).
 *
 * Effort precedence is a call-site concern for M3b: web takes
 * `harnessEffort?.trim() || (effort !== 'off' ? effort : undefined)` —
 * the `off` sentinel applies only to the legacy `effort` field, not to
 * `harnessEffort`. This helper receives a single already-resolved [effort]
 * and drops `off`.
 */
fun spawnModelEffort(
    sheet: HarnessSheet?,
    harnessId: String? = null,
    model: String? = null,
    effort: String? = null,
): SpawnFlags {
    if (harnessId.isNullOrBlank() || sheet == null) return SpawnFlags()
    val modelOut = model?.trim()?.takeIf { it.isNotEmpty() }
        ?.takeIf { !sheet.modelFlag.isNullOrBlank() }
        ?.takeIf { m -> sheet.models?.any { it.id == m } == true }
    val effortRaw = effort?.trim()?.takeIf { it.isNotEmpty() && it != "off" }
    val effortOut = effortRaw
        ?.takeIf { !sheet.effortFlag.isNullOrBlank() }
        ?.takeIf { e -> effortListFor(sheet, modelOut ?: "").any { it.id == e } }
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

data class SummaryControls(
    val transport: String?,
    val model: String,
    val effort: String,
)

/**
 * Keep [currentModel]/[currentEffort] when they still exist on the native catalog;
 * otherwise fall through incoming summary ids, then default/first. A catalog that
 * drops the selected id must not leave those values on the next [buildUserTurn].
 * Empty native catalog (PTY / no turnOptions) leaves the current pair alone.
 */
fun reconcileSummaryControls(
    sheet: HarnessSheet?,
    currentTransport: String?,
    currentModel: String,
    currentEffort: String,
    incomingTransport: String? = null,
    incomingModel: String? = null,
    incomingEffort: String? = null,
): SummaryControls {
    val nextTransport = incomingTransport ?: currentTransport
    val native = nativeTurnModels(sheet, nextTransport)
    val nextModel = when {
        native.isEmpty() -> currentModel
        native.any { it.id == currentModel } -> currentModel
        native.any { it.id == incomingModel } -> incomingModel!!
        else -> native.find { it.default }?.id ?: native.firstOrNull()?.id ?: currentModel
    }
    val efforts = native.find { it.id == nextModel }?.efforts.orEmpty()
    val nextEffort = when {
        efforts.isEmpty() -> currentEffort
        efforts.any { it.id == currentEffort } -> currentEffort
        efforts.any { it.id == incomingEffort } -> incomingEffort!!
        else -> efforts.find { it.default }?.id ?: efforts.firstOrNull()?.id ?: currentEffort
    }
    return SummaryControls(nextTransport, nextModel, nextEffort)
}
