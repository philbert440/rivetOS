package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.data.SessionFrame
import dev.rivetos.bots.data.SessionMessage
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.domain.Bot
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

class ChatViewModel(private val c: AppContainer, val bot: Bot, initialSessionId: String) : ViewModel() {
    data class UiState(
        val sessionId: String,
        val messages: List<SessionMessage> = emptyList(),
        val pendingText: String = "",
        val working: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val error: String? = null,
        val loading: Boolean = true,
    )

    private val _state = MutableStateFlow(UiState(initialSessionId))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var watch: Closeable? = null
    private var doneTimer: Job? = null

    init { open(initialSessionId) }

    private fun open(sessionId: String) {
        watch?.close()
        _state.update { UiState(sessionId) }
        val gw = c.gateways.get(bot.denUrl)
        viewModelScope.launch {
            try {
                val msgs = gw.messages(sessionId)
                _state.update { it.copy(messages = msgs, loading = false) }
                msgs.lastOrNull()?.let { c.settings.markSeen(bot.id, it.ts) }
            } catch (e: Exception) {
                _state.update { it.copy(error = BotRepository.friendly(e), loading = false) }
            }
        }
        watch = gw.watchSessions(sessionId, onFrame = ::onFrame, onStatus = { s -> _state.update { it.copy(ws = s) } })
    }

    private fun onFrame(f: SessionFrame) {
        when (f) {
            is SessionFrame.Message -> {
                val m = f.message
                if (m.sessionId.isNotBlank() && m.sessionId != _state.value.sessionId) return
                _state.update { s ->
                    var list = s.messages
                    if (m.role == "user") {
                        // Replace our optimistic echo of the same text, if any.
                        val idx = list.indexOfFirst { it.id.startsWith("local-") && it.text == m.text }
                        if (idx >= 0) list = list.toMutableList().also { it.removeAt(idx) }
                    }
                    if (list.any { it.id == m.id }) s
                    else s.copy(
                        messages = list + m,
                        pendingText = if (m.role == "assistant") "" else s.pendingText,
                        working = if (m.role == "assistant") null else s.working,
                    )
                }
                if (m.role == "assistant") {
                    doneTimer?.cancel()
                    viewModelScope.launch { c.settings.markSeen(bot.id, m.ts) }
                }
            }
            is SessionFrame.Stream -> onStream(f)
            else -> Unit
        }
    }

    private fun onStream(e: SessionFrame.Stream) {
        when (e.type) {
            "text" -> _state.update { it.copy(pendingText = it.pendingText + e.content, working = null) }
            "reasoning" -> _state.update { it.copy(working = "Thinking…") }
            "tool_start" -> _state.update { it.copy(working = "Using ${e.content.ifBlank { "a tool" }}") }
            "tool_result" -> _state.update { it.copy(working = "Working…") }
            "status" -> _state.update { it.copy(working = e.content.ifBlank { it.working }) }
            "error" -> _state.update { it.copy(error = e.content, working = null) }
            "done" -> {
                _state.update { it.copy(working = null) }
                // The committed message frame normally follows; if it never does,
                // promote the streamed text so the reply isn't lost.
                doneTimer?.cancel()
                doneTimer = viewModelScope.launch {
                    delay(1500)
                    _state.update { s ->
                        if (s.pendingText.isBlank()) s else s.copy(
                            messages = s.messages + SessionMessage(
                                id = "stream-${UUID.randomUUID()}", sessionId = s.sessionId,
                                role = "assistant", text = s.pendingText, ts = System.currentTimeMillis(),
                            ),
                            pendingText = "",
                        )
                    }
                }
            }
        }
    }

    fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        val sid = _state.value.sessionId
        val local = SessionMessage(id = "local-${UUID.randomUUID()}", sessionId = sid, role = "user", text = t, ts = System.currentTimeMillis())
        _state.update { it.copy(messages = it.messages + local, error = null, working = "${bot.displayName} is working…") }
        viewModelScope.launch {
            try {
                val p = c.settings.snapshot()
                c.gateways.get(bot.denUrl).post(sid, t, p.handle, bot.agent)
            } catch (e: Exception) {
                _state.update { s -> s.copy(messages = s.messages.filter { it.id != local.id }, error = BotRepository.friendly(e), working = null) }
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    /** Start a fresh thread with this bot (old one stays on the node). */
    fun newConversation() {
        val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmm"))
        val sid = bot.defaultSessionId(c.identity.deviceTag()) + "-" + stamp
        viewModelScope.launch { c.settings.setSessionOverride(bot.id, sid) }
        open(sid)
    }

    override fun onCleared() { watch?.close() }
}
