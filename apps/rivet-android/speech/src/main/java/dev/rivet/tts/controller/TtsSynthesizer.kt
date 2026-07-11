package dev.rivet.tts.controller

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import dev.rivet.tts.model.AudioChunk
import dev.rivet.tts.model.AudioFormat
import dev.rivet.tts.model.TTSRequest
import dev.rivet.tts.model.TTSResponse
import android.util.Log
import dev.rivet.tts.provider.TTSManager
import dev.rivet.tts.provider.TTSProviderSetting
import dev.rivet.tts.provider.providers.XaiTtsAuthException
import dev.rivet.tts.provider.providers.XaiTtsRequestException
import java.io.ByteArrayOutputStream

private const val TAG = "TtsSynthesizer"

/**
 * Bridge TTS provider flow to a single audio buffer.
 */
class TtsSynthesizer(
    private val ttsManager: TTSManager
) {
    suspend fun synthesize(
        setting: TTSProviderSetting,
        chunk: TtsChunk,
        systemFallback: TTSProviderSetting.SystemTTS? = null,
    ): TTSResponse = withContext(Dispatchers.IO) {
        try {
            collectToResponse(
                ttsManager.generateSpeech(setting, TTSRequest(text = chunk.text, language = chunk.language))
            )
        } catch (e: Exception) {
            if (shouldFallbackToSystem(setting, e, systemFallback)) {
                Log.w(TAG, "xAI TTS unavailable, falling back to system TTS: ${e.message}")
                return@withContext collectToResponse(
                    ttsManager.generateSpeech(systemFallback!!, TTSRequest(text = chunk.text, language = chunk.language))
                )
            }
            throw e
        }
    }

    private fun shouldFallbackToSystem(
        setting: TTSProviderSetting,
        error: Exception,
        systemFallback: TTSProviderSetting.SystemTTS?,
    ): Boolean {
        if (systemFallback == null) return false
        if (setting !is TTSProviderSetting.XAI || !setting.fallbackToSystem) return false
        return when (error) {
            is XaiTtsAuthException -> true
            is XaiTtsRequestException -> error.shouldFallbackToSystem()
            else -> false
        }
    }

    private suspend fun collectToResponse(flow: Flow<AudioChunk>): TTSResponse {
        var format: AudioFormat? = null
        var sampleRate: Int? = null
        val output = ByteArrayOutputStream()
        flow.collect { chunk ->
            if (format == null) format = chunk.format
            if (sampleRate == null) sampleRate = chunk.sampleRate
            output.write(chunk.data)
        }
        return TTSResponse(
            audioData = output.toByteArray(),
            format = format ?: AudioFormat.MP3,
            sampleRate = sampleRate
        )
    }
}

