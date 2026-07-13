package dev.rivet.app.data.datastore

import dev.rivet.ai.provider.Modality
import dev.rivet.ai.provider.Model
import dev.rivet.ai.provider.ModelAbility
import dev.rivet.ai.provider.ProviderSetting
import dev.rivet.ai.registry.ModelRegistry
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.uuid.Uuid

/**
 * Native chat talks to whichever RivetOS node is selected via the drawer switcher.
 *
 * The Rivet [ProviderSetting.OpenAI] with [RIVET_BRIDGE_PROVIDER_ID] is the single chat
 * backend — its `baseUrl` is repointed on node select (local bridge vs remote den `/v1`).
 * The hub WebView is never a node-switch destination.
 */
object NodeChatBackend {

    /** Local on-device bridge (proven even when full den/runtime isn't provisioned). */
    const val LOCAL_BRIDGE_BASE_URL = "http://127.0.0.1:$RIVET_BRIDGE_PORT/v1"

    /**
     * True for the Rivet agent-session provider — turns are live agent runs that must
     * queue (not cancel-and-replace) and carry `x-rivet-conversation` headers. Applies
     * whether the provider currently points at the local bridge or a remote den `/v1`.
     */
    fun isAgentSessionProvider(provider: ProviderSetting?): Boolean =
        provider?.id == RIVET_BRIDGE_PROVIDER_ID

    fun isAgentSessionProviderId(id: Uuid?): Boolean =
        id == RIVET_BRIDGE_PROVIDER_ID

    /**
     * OpenAI-compat chat base URL for a roster node's den URL.
     * - Local node → loopback bridge `:8765/v1`
     * - Remote node → `{denUrl}/v1` (den OpenAI-compat mount)
     */
    fun chatBaseUrlForNode(denUrl: String): String {
        val normalized = NodeRosterDefaults.normalizeDenUrl(denUrl)
        return if (NodeRosterDefaults.isLocalDenUrl(normalized) || normalized.isBlank()) {
            LOCAL_BRIDGE_BASE_URL
        } else {
            "$normalized/v1"
        }
    }

    /** Health probe URL for the agent strip — what chat is talking to. */
    fun agentHealthUrlForNode(denUrl: String): String {
        val normalized = NodeRosterDefaults.normalizeDenUrl(denUrl)
        return if (NodeRosterDefaults.isLocalDenUrl(normalized) || normalized.isBlank()) {
            "http://127.0.0.1:$RIVET_BRIDGE_PORT/health"
        } else {
            "$normalized/healthz"
        }
    }

    /**
     * Deterministic [Model.id] from the agent/model string so switching nodes (and back)
     * does not orphan [Settings.chatModelId] / [dev.rivet.app.data.model.Assistant.chatModelId].
     *
     * Well-known local agents keep the historical fixed UUIDs already stored in prefs.
     */
    fun stableAgentModelId(modelId: String): Uuid = when (modelId) {
        "rivet-claude" -> DEFAULT_AUTO_MODEL_ID
        "rivet-grok" -> RIVET_GROK_MODEL_ID
        else -> Uuid.parse(
            UUID.nameUUIDFromBytes("rivet-agent:$modelId".toByteArray(StandardCharsets.UTF_8))
                .toString()
        )
    }

    fun modelFromAgentId(modelId: String, displayName: String = modelId): Model {
        val abilities = ModelRegistry.MODEL_ABILITIES.getData(modelId).ifEmpty {
            listOf(ModelAbility.TOOL, ModelAbility.REASONING)
        }
        val prettyName = when (modelId) {
            "rivet-claude" -> "Claude"
            "rivet-grok" -> "Grok"
            else -> displayName.ifBlank { modelId }
        }
        return Model(
            id = stableAgentModelId(modelId),
            modelId = modelId,
            displayName = prettyName,
            inputModalities = ModelRegistry.MODEL_INPUT_MODALITIES.getData(modelId)
                .ifEmpty { listOf(Modality.TEXT) },
            outputModalities = ModelRegistry.MODEL_OUTPUT_MODALITIES.getData(modelId)
                .ifEmpty { listOf(Modality.TEXT) },
            abilities = abilities,
        )
    }

    /**
     * Rewrite the Rivet provider's baseUrl + models for [denUrl], and re-bind chat model
     * prefs if the previous selection is missing on the new node.
     *
     * Fetches models **before** mutating settings. On failure the caller must leave the
     * existing provider config intact (this function does not write anything itself).
     *
     * @throws Exception if the node is unreachable, `/models` fails, or returns no models
     */
    suspend fun repointProvider(
        settings: Settings,
        denUrl: String,
        listModels: suspend (ProviderSetting.OpenAI) -> List<Model>,
    ): Settings {
        val normalizedDen = NodeRosterDefaults.normalizeDenUrl(denUrl)
            .ifBlank { NodeRosterDefaults.localDenUrl() }
        val baseUrl = chatBaseUrlForNode(normalizedDen)

        val existing = settings.providers
            .filterIsInstance<ProviderSetting.OpenAI>()
            .firstOrNull { it.id == RIVET_BRIDGE_PROVIDER_ID }
            ?: error("Rivet provider ($RIVET_BRIDGE_PROVIDER_ID) is missing from settings")

        val probe = existing.copy(baseUrl = baseUrl)
        val listed = listModels(probe)
        if (listed.isEmpty()) {
            error("Node has no agents at $baseUrl/models")
        }

        val models = listed
            .map { modelFromAgentId(it.modelId, it.displayName) }
            .distinctBy { it.id }

        val modelIds = models.map { it.id }.toSet()
        val fallbackId = models.first().id

        val providers = settings.providers.map { provider ->
            if (provider is ProviderSetting.OpenAI && provider.id == RIVET_BRIDGE_PROVIDER_ID) {
                provider.copy(baseUrl = baseUrl, models = models)
            } else {
                provider
            }
        }

        val chatModelId = if (settings.chatModelId in modelIds) {
            settings.chatModelId
        } else {
            fallbackId
        }

        val assistants = settings.assistants.map { assistant ->
            val mid = assistant.chatModelId
            if (mid != null && mid !in modelIds) {
                assistant.copy(chatModelId = fallbackId)
            } else {
                assistant
            }
        }

        return settings.copy(
            providers = providers,
            chatModelId = chatModelId,
            assistants = assistants,
            activeNodeDenUrl = normalizedDen,
        )
    }
}
