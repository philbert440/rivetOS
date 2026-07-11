package dev.rivet.asr

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.uuid.Uuid

// RivetHub keeps exactly one cloud ASR backend: the OpenAI Realtime websocket API.
// Volcengine/DashScope were deleted in the Phase 2 strip-down; stored settings that
// still reference them are filtered out at datastore-decode time (see PreferencesStore).
@Serializable
sealed class ASRProviderSetting {
    abstract val id: Uuid
    abstract val name: String

    abstract fun copyProvider(
        id: Uuid = this.id,
        name: String = this.name,
    ): ASRProviderSetting

    @Serializable
    @SerialName("openai_realtime")
    data class OpenAIRealtime(
        override val id: Uuid = Uuid.random(),
        override val name: String = "OpenAI Realtime ASR",
        val apiKey: String = "",
        val websocketUrl: String = "wss://api.openai.com/v1/realtime?intent=transcription",
        val model: String = "gpt-4o-transcribe",
        val language: String = "",
        val prompt: String = "",
        val sampleRate: Int = 24000,
        val vadThreshold: Float = 0.5f,
        val prefixPaddingMs: Int = 300,
        val silenceDurationMs: Int = 500,
    ) : ASRProviderSetting() {
        override fun copyProvider(
            id: Uuid,
            name: String,
        ): ASRProviderSetting {
            return this.copy(
                id = id,
                name = name,
            )
        }
    }

    // xAI Speech-to-Text: proprietary streaming protocol at wss://api.x.ai/v1/stt — raw
    // PCM16 binary frames, config via URL query params, transcript.* JSON events. NOT
    // OpenAI-Realtime compatible, so it has its own controller (XAIASRController).
    @Serializable
    @SerialName("xai")
    data class XAI(
        override val id: Uuid = Uuid.random(),
        override val name: String = "xAI STT",
        val apiKey: String = "",
        val websocketUrl: String = "wss://api.x.ai/v1/stt",
        val model: String = "grok-stt",
        val sampleRate: Int = 16000,
        // Blank = omit the language query param so xAI auto-detects (needed for EN↔ZH).
        val language: String = "",
        val interimResults: Boolean = true,
    ) : ASRProviderSetting() {
        override fun copyProvider(
            id: Uuid,
            name: String,
        ): ASRProviderSetting {
            return this.copy(
                id = id,
                name = name,
            )
        }
    }

    companion object {
        val Types by lazy {
            listOf(
                OpenAIRealtime::class,
                XAI::class,
            )
        }
    }
}
