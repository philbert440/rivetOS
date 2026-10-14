package io.rivethub.app.plane

import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.ModelOption

/**
 * Per-turn model/effort override for one conversation — twin of rivethub-web
 * `lib/conversation-model-options.ts` (#805). Never a spawn flag: it rides the
 * next [io.rivethub.app.gateway.UserTurn] only. A null field means "use the
 * session's / harness's default".
 */
data class ConversationTurnPick(
    val harnessId: String,
    val model: String? = null,
    val effort: String? = null,
)

/** Persisted as `harnessId\tmodel\teffort` (empty field = unset) in the `turnPicks` pref map. */
fun encodeTurnPick(pick: ConversationTurnPick): String =
    listOf(pick.harnessId, pick.model.orEmpty(), pick.effort.orEmpty()).joinToString("\t")

fun decodeTurnPick(raw: String?): ConversationTurnPick? {
    val parts = raw?.split('\t') ?: return null
    val harnessId = parts.getOrNull(0)?.trim().orEmpty()
    if (harnessId.isEmpty()) return null
    return ConversationTurnPick(
        harnessId = harnessId,
        model = parts.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() },
        effort = parts.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() },
    )
}

/**
 * Whether the control plane owns this conversation over the protocol
 * transport: true / false once both the session summary and the harness
 * registry have settled, null (unknown) while either is loading or failed.
 * Unknown never clears a saved pick and never blocks a send.
 */
fun conversationProtocolOwnership(
    summaryReady: Boolean,
    registryReady: Boolean,
    bound: Boolean,
    transport: String?,
): Boolean? {
    if (!summaryReady || !registryReady) return null
    return bound && transport == "protocol"
}

data class TurnModelOptions(
    /** Offered models; empty = no picker. */
    val models: List<ModelOption>,
    val efforts: List<EffortOption>,
    /** What the next turn carries — only explicit, still-offered picks. */
    val effectiveModel: String?,
    val effectiveEffort: String?,
    /** The stored pick must be replaced by [retainedPick] (null = removed). */
    val clearPick: Boolean,
    val retainedPick: ConversationTurnPick?,
    /** Label of the session's current model for "Session default (X)"; null = "Harness default". */
    val sessionDefaultLabel: String?,
    /** The model the turn will run on (pick, else session/harness default) — image-modality checks. */
    val selectedModel: ModelOption?,
)

/**
 * Options for the composer's per-turn picker. Resolves only the
 * conversation's own harness sheet ([sheet] = that harness's capabilities,
 * [registryReady] = the registry fetch settled), never an agent default.
 */
fun conversationModelOptions(
    harnessId: String?,
    sheet: HarnessSheet?,
    registryReady: Boolean,
    pick: ConversationTurnPick?,
    protocolOwned: Boolean?,
    currentModel: String? = null,
): TurnModelOptions {
    val models = if (protocolOwned == true && sheet?.turnOptions == true) sheet.models.orEmpty() else emptyList()
    val stale = pick != null && (
        pick.harnessId != harnessId ||
            models.isEmpty() ||
            (pick.model != null && models.none { it.id == pick.model })
        )
    val model = if (!stale) pick?.model else null
    val current = currentModel?.trim()?.takeIf { it.isNotEmpty() }
    val defaultModel = if (current != null) {
        models.find { it.id == current }
    } else {
        models.find { it.default } ?: models.firstOrNull()
    }
    val selected = models.find { it.id == model } ?: defaultModel
    val efforts = if (models.isNotEmpty() && selected != null) {
        selected.efforts ?: sheet?.efforts.orEmpty()
    } else {
        emptyList()
    }
    val effort = if (!stale && efforts.any { it.id == pick?.effort }) pick?.effort else null
    val retained = if (harnessId != null && (model != null || effort != null)) {
        ConversationTurnPick(harnessId, model, effort)
    } else {
        null
    }
    // A harness change clears immediately; otherwise unknown ownership preserves the pick.
    val clear = when {
        pick != null && harnessId != null && pick.harnessId != harnessId -> true
        protocolOwned == false -> pick != null
        else -> protocolOwned == true &&
            harnessId != null &&
            registryReady &&
            (stale || (pick?.effort != null && effort == null))
    }
    return TurnModelOptions(
        models = models,
        efforts = efforts,
        effectiveModel = model,
        effectiveEffort = effort,
        clearPick = clear,
        retainedPick = retained,
        sessionDefaultLabel = current?.let { defaultModel?.label ?: it },
        selectedModel = selected,
    )
}
