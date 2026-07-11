package dev.rivet.tts.provider

import android.content.Context
import kotlinx.coroutines.flow.Flow
import dev.rivet.tts.model.AudioChunk
import dev.rivet.tts.model.TTSRequest

interface TTSProvider<T : TTSProviderSetting> {
    fun generateSpeech(
        context: Context,
        providerSetting: T,
        request: TTSRequest
    ): Flow<AudioChunk>
}
