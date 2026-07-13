package dev.rivet.app.data.datastore

import dev.rivet.ai.provider.Modality
import dev.rivet.ai.provider.Model
import dev.rivet.ai.provider.ModelAbility
import dev.rivet.ai.provider.ProviderSetting
import dev.rivet.ai.registry.ModelRegistry
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.uuid.Uuid
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Native chat talks to whichever RivetOS node is selected via the drawer switcher.
 *
 * The Rivet [ProviderSetting.OpenAI] with [RIVET_BRIDGE_PROVIDER_ID] is the single chat
 * backend — its `baseUrl` is repointed on node select (local bridge vs remote den `/v1`).
 * The hub WebView is never a node-switch destination.
 *
 * **Invariant:** [Settings.activeNodeDenUrl] and the Rivet provider's `baseUrl` always
 * move together. Never write one without the other (see [applyRepoint] /
 * [forceLocalChatBackend]).
 */
object NodeChatBackend {

    /** Local on-device bridge (proven even when full den/runtime isn't provisioned). */
    const val LOCAL_BRIDGE_BASE_URL = "http://127.0.0.1:$RIVET_BRIDGE_PORT/v1"

    /**
     * Serializes node switches so two rapid selects cannot interleave probe/write and leave
     * `activeNodeDenUrl` and `baseUrl` pointing at different nodes. Last switch wins for both.
     */
    private val switchMutex = Mutex()

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
     * Soft-align Rivet `baseUrl` to [Settings.activeNodeDenUrl] without probing models.
     * Used on upgrade: pre-repoint builds wrote `activeNodeDenUrl` alone.
     * Returns the same instance when already consistent.
     */
    fun reconcileActiveNodeBaseUrl(settings: Settings): Settings {
        val den = settings.activeNodeDenUrl
            .ifBlank { NodeRosterDefaults.localDenUrl() }
            .let { NodeRosterDefaults.normalizeDenUrl(it) }
        val expected = chatBaseUrlForNode(den)
        val rivet = settings.providers
            .filterIsInstance<ProviderSetting.OpenAI>()
            .firstOrNull { it.id == RIVET_BRIDGE_PROVIDER_ID }
            ?: return settings
        if (rivet.baseUrl == expected &&
            NodeRosterDefaults.normalizeDenUrl(settings.activeNodeDenUrl) == den
        ) {
            return settings
        }
        return settings.copy(
            activeNodeDenUrl = den,
            providers = settings.providers.map { provider ->
                if (provider is ProviderSetting.OpenAI && provider.id == RIVET_BRIDGE_PROVIDER_ID) {
                    provider.copy(baseUrl = expected)
                } else {
                    provider
                }
            },
        )
    }

    /**
     * Force both [Settings.activeNodeDenUrl] and Rivet `baseUrl` to the local bridge
     * without probing. Keeps existing model list (last-known agents). Used when remove-
     * of-active-node cannot refresh models — both fields stay consistent.
     */
    fun forceLocalChatBackend(settings: Settings): Settings {
        val localDen = NodeRosterDefaults.localDenUrl()
        val providers = settings.providers.map { provider ->
            if (provider is ProviderSetting.OpenAI && provider.id == RIVET_BRIDGE_PROVIDER_ID) {
                provider.copy(baseUrl = LOCAL_BRIDGE_BASE_URL)
            } else {
                provider
            }
        }
        return settings.copy(
            providers = providers,
            activeNodeDenUrl = localDen,
        )
    }

    /**
     * Pure apply: rewrite Rivet baseUrl + models for [denUrl] and re-bind chat / secondary
     * model prefs when the previous selection was a Rivet agent now missing on the new node.
     *
     * Does not probe. Prefer [repointProvider] (probe then apply) or [switchNode] (race-safe).
     */
    fun applyRepoint(
        settings: Settings,
        denUrl: String,
        listed: List<Model>,
    ): Settings {
        val normalizedDen = NodeRosterDefaults.normalizeDenUrl(denUrl)
            .ifBlank { NodeRosterDefaults.localDenUrl() }
        val baseUrl = chatBaseUrlForNode(normalizedDen)

        val existing = settings.providers
            .filterIsInstance<ProviderSetting.OpenAI>()
            .firstOrNull { it.id == RIVET_BRIDGE_PROVIDER_ID }
            ?: error("Rivet provider ($RIVET_BRIDGE_PROVIDER_ID) is missing from settings")

        if (listed.isEmpty()) {
            error("Node has no agents at $baseUrl/models")
        }

        val models = listed
            .map { modelFromAgentId(it.modelId, it.displayName) }
            .distinctBy { it.id }

        val modelIds = models.map { it.id }.toSet()
        val oldRivetModelIds = existing.models.map { it.id }.toSet()
        val fallbackId = models.first().id

        /** Secondary prefs: only rebind if the id was a Rivet agent (avoid clobbering other providers). */
        fun rebindIfWasRivet(id: Uuid): Uuid = when {
            id in modelIds -> id
            id in oldRivetModelIds -> fallbackId
            else -> id
        }

        val providers = settings.providers.map { provider ->
            if (provider is ProviderSetting.OpenAI && provider.id == RIVET_BRIDGE_PROVIDER_ID) {
                provider.copy(baseUrl = baseUrl, models = models)
            } else {
                provider
            }
        }

        val assistants = settings.assistants.map { assistant ->
            val mid = assistant.chatModelId
            if (mid != null && mid !in modelIds) {
                // Primary assistant chat selection: same as chatModelId — always rebind if missing.
                assistant.copy(chatModelId = fallbackId)
            } else {
                assistant
            }
        }

        val chatModelId = if (settings.chatModelId in modelIds) {
            settings.chatModelId
        } else {
            fallbackId
        }

        return settings.copy(
            providers = providers,
            chatModelId = chatModelId,
            titleModelId = rebindIfWasRivet(settings.titleModelId),
            translateModeId = rebindIfWasRivet(settings.translateModeId),
            suggestionModelId = rebindIfWasRivet(settings.suggestionModelId),
            compressModelId = rebindIfWasRivet(settings.compressModelId),
            assistants = assistants,
            activeNodeDenUrl = normalizedDen,
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
        return applyRepoint(settings, normalizedDen, listed)
    }

    /**
     * Race-safe node switch: serializes under [switchMutex], reads latest settings from the
     * store (not a composition snapshot), probes, then writes via store-relative [SettingsStore.update]
     * so the last switch wins for **both** `activeNodeDenUrl` and Rivet `baseUrl`+models.
     *
     * @param transform applied to the latest settings **before** probe (e.g. roster filter on remove)
     */
    suspend fun switchNode(
        settingsStore: SettingsStore,
        denUrl: String,
        listModels: suspend (ProviderSetting.OpenAI) -> List<Model>,
        transform: (Settings) -> Settings = { it },
    ): Settings = switchMutex.withLock {
        val snapshot = awaitReadySettings(settingsStore)
        val prepared = transform(snapshot)
        val normalizedDen = NodeRosterDefaults.normalizeDenUrl(denUrl)
            .ifBlank { NodeRosterDefaults.localDenUrl() }
        val baseUrl = chatBaseUrlForNode(normalizedDen)

        val existing = prepared.providers
            .filterIsInstance<ProviderSetting.OpenAI>()
            .firstOrNull { it.id == RIVET_BRIDGE_PROVIDER_ID }
            ?: error("Rivet provider ($RIVET_BRIDGE_PROVIDER_ID) is missing from settings")

        val listed = listModels(existing.copy(baseUrl = baseUrl))

        // Store-relative write: re-apply transform + pure repoint on whatever is current
        // under the store mutex so concurrent non-switch edits are not lost and the last
        // serialized switch's denUrl/models always land together.
        settingsStore.update { latest ->
            applyRepoint(transform(latest), normalizedDen, listed)
        }
        awaitReadySettings(settingsStore)
    }

    /**
     * Race-safe remove of the active node when model refresh fails: drop peer from roster
     * and force local active + bridge baseUrl together (store-relative).
     */
    suspend fun removeActiveFallbackLocal(
        settingsStore: SettingsStore,
        removeDenUrl: String,
    ): Settings = switchMutex.withLock {
        val url = NodeRosterDefaults.normalizeDenUrl(removeDenUrl)
        settingsStore.update { latest ->
            val roster = latest.nodeRoster.ifEmpty { NodeRosterDefaults.seed() }
            val nextRoster = roster.filter {
                NodeRosterDefaults.normalizeDenUrl(it.denUrl) != url
            }.ifEmpty { NodeRosterDefaults.seed() }
            forceLocalChatBackend(latest.copy(nodeRoster = nextRoster))
        }
        awaitReadySettings(settingsStore)
    }

    private suspend fun awaitReadySettings(settingsStore: SettingsStore): Settings {
        val current = settingsStore.settingsFlow.value
        if (!current.init) return current
        // Flow may still be dummy at first frame — wait for real prefs.
        return settingsStore.settingsFlowRaw.first { !it.init }
    }
}
