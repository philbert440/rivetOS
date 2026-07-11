package dev.rivet.ai.provider.providers.openai

import kotlinx.coroutines.flow.Flow
import dev.rivet.ai.provider.ProviderSetting
import dev.rivet.ai.provider.TextGenerationParams
import dev.rivet.ai.ui.MessageChunk
import dev.rivet.ai.ui.UIMessage

interface OpenAIImpl {
    suspend fun generateText(
        providerSetting: ProviderSetting.OpenAI,
        messages: List<UIMessage>,
        params: TextGenerationParams,
    ): MessageChunk

    suspend fun streamText(
        providerSetting: ProviderSetting.OpenAI,
        messages: List<UIMessage>,
        params: TextGenerationParams,
    ): Flow<MessageChunk>
}
