package dev.rivet.tts.provider.providers

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import dev.rivet.tts.model.AudioChunk
import dev.rivet.tts.model.AudioFormat
import dev.rivet.tts.model.TTSRequest
import dev.rivet.tts.provider.GrokOAuthToken
import dev.rivet.tts.provider.TTSProvider
import dev.rivet.tts.provider.TTSProviderSetting
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG = "XAITTSProvider"

class XAITTSProvider : TTSProvider<TTSProviderSetting.XAI> {
    private val httpClient = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    override fun generateSpeech(
        context: Context,
        providerSetting: TTSProviderSetting.XAI,
        request: TTSRequest
    ): Flow<AudioChunk> = flow {
        val token = resolveToken(context, providerSetting)
            ?: throw XaiTtsAuthException("No xAI credentials — sign in with Grok or add an API key")

        // Per-utterance language hint (from the translator) overrides the fixed configured language,
        // so each translation is spoken in its target language rather than the provider default.
        val language = request.language ?: providerSetting.language
        val requestBody = JSONObject().apply {
            put("text", request.text)
            put("voice_id", providerSetting.voiceId)
            put("language", language)
        }

        Log.i(TAG, "generateSpeech voice=${providerSetting.voiceId} lang=$language")

        val httpRequest = Request.Builder()
            .url("${providerSetting.baseUrl.trimEnd('/')}/tts")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(httpRequest).execute()
        if (!response.isSuccessful) {
            val errorBody = response.body?.string().orEmpty()
            Log.e(TAG, "generateSpeech: ${response.code} ${response.message} $errorBody")
            throw XaiTtsRequestException(response.code, response.message, errorBody)
        }

        val audioData = response.body.bytes()
        emit(
            AudioChunk(
                data = audioData,
                format = AudioFormat.MP3,
                isLast = true,
                metadata = mapOf(
                    "provider" to "xai",
                    "voice_id" to providerSetting.voiceId,
                    "language" to language,
                )
            )
        )
    }

    private fun resolveToken(context: Context, setting: TTSProviderSetting.XAI): String? {
        if (setting.apiKey.isNotBlank()) return setting.apiKey
        if (setting.useGrokOAuth) return GrokOAuthToken.read(context)
        return null
    }
}

class XaiTtsAuthException(message: String) : Exception(message)

class XaiTtsRequestException(
    val statusCode: Int,
    statusMessage: String,
    val responseBody: String,
) : Exception("xAI TTS request failed: $statusCode $statusMessage") {
    fun shouldFallbackToSystem(): Boolean =
        statusCode == 401 ||
            statusCode == 402 ||
            statusCode == 403 ||
            statusCode == 429 ||
            responseBody.contains("credit", ignoreCase = true) ||
            responseBody.contains("quota", ignoreCase = true) ||
            responseBody.contains("billing", ignoreCase = true)
}