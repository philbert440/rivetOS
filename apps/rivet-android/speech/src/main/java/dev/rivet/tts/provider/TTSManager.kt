package dev.rivet.tts.provider

import android.content.Context
import kotlinx.coroutines.flow.Flow
import dev.rivet.tts.model.AudioChunk
import dev.rivet.tts.model.TTSRequest
import dev.rivet.tts.provider.providers.OpenAITTSProvider
import dev.rivet.tts.provider.providers.SystemTTSProvider
import dev.rivet.tts.provider.providers.XAITTSProvider

class TTSManager(private val context: Context) {
    private val openAIProvider = OpenAITTSProvider()
    private val systemProvider = SystemTTSProvider()
    private val xaiProvider = XAITTSProvider()

    fun generateSpeech(
        providerSetting: TTSProviderSetting,
        request: TTSRequest
    ): Flow<AudioChunk> {
        return when (providerSetting) {
            is TTSProviderSetting.OpenAI -> openAIProvider.generateSpeech(context, providerSetting, request)
            is TTSProviderSetting.SystemTTS -> systemProvider.generateSpeech(context, providerSetting, request)
            is TTSProviderSetting.XAI -> xaiProvider.generateSpeech(context, providerSetting, request)
        }
    }
}
