package dev.rivet.app.data.ai

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import dev.rivet.ai.provider.ProviderSetting
import dev.rivet.ai.provider.TextGenerationParams
import dev.rivet.ai.ui.UIMessage

sealed class AILogging {
    data class Generation(
        val params: TextGenerationParams,
        val messages: List<UIMessage>,
        val providerSetting: ProviderSetting,
        val stream: Boolean,
    ) : AILogging()
}

private const val MAX_LOGS = 32

class AILoggingManager {
    private val logs = MutableStateFlow<List<AILogging>>(emptyList())

    fun getLogs(): StateFlow<List<AILogging>> = logs

    fun addLog(log: AILogging) {
        logs.value = logs.value + log
        if (logs.value.size > MAX_LOGS) {
            logs.value = logs.value.drop(1)
        }
    }

    fun clearLogs() {
        logs.value = emptyList()
    }
}
