package dev.rivet.app.ui.pages.developer

import androidx.lifecycle.ViewModel
import dev.rivet.app.data.ai.AILoggingManager

class DeveloperVM(
    private val aiLoggingManager: AILoggingManager
) : ViewModel() {
    val logs = aiLoggingManager.getLogs()
}
