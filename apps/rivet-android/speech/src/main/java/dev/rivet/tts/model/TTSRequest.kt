package dev.rivet.tts.model

import kotlinx.serialization.Serializable

@Serializable
data class TTSRequest(
    val text: String,
    /**
     * Optional BCP-47 language hint for this utterance (e.g. "en", "zh"). When set, language-aware
     * providers should synthesize in this language instead of their fixed configured one — this is
     * how the realtime translator makes a provider speak each translation in its target language.
     * Null = use the provider's configured language/voice (default behavior for chat/auto-play).
     */
    val language: String? = null
)

@Serializable
enum class AudioFormat {
    MP3,
    WAV,
    OGG,
    AAC,
    OPUS,
    PCM
}