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
    private var workingTimer: Job? = null
    private var fetchJob: Job? = null
    private var everOpen = false

    init { open(initialSessionId) }

    private fun open(sessionId: String) {
        watch?.close()
        doneTimer?.cancel(); workingTimer?.cancel(); fetchJob?.cancel()
        everOpen = false
        _state.update { UiState(sessionId) }
        fetchJob = fetch(sessionId)
        watch = c.gateways.get(bot.denUrl).watchSessions(
            sessionId,
            onFrame = { f -> onFrame(sessionId, f) },
            onStatus = { s ->
                _state.update { it.copy(ws = s) }
                // The ring is process-local and the WS has no replay: after a
                // reconnect, re-read the transcript to pick up anything missed.
                if (s == WsStatus.OPEN) { if (everOpen) fetchJob = fetch(sessionId) else everOpen = true }
            },
        )
    }

    /** Transcript read that merges with whatever live frames already landed. */
    private fun fetch(sessionId: String): Job = viewModelScope.launch {
        try {
            val msgs = c.gateways.get(bot.denUrl).messages(sessionId)
            if (_state.value.sessionId != sessionId) return@launch
            _state.update { s -> s.copy(messages = mergeTranscript(msgs, s.messages), loading = false) }
            msgs.lastOrNull()?.let { c.settings.markSeen(bot.id, it.ts) }
        } catch (e: Exception) {
            if (_state.value.sessionId != sessionId) return@launch
            _state.update { it.copy(error = BotRepository.friendly(e), loading = false) }
        }
    }

    private fun onFrame(sessionId: String, f: SessionFrame) {
        if (_state.value.sessionId != sessionId) return
        when (f) {
            is SessionFrame.Message -> {
                val m = f.message
                if (m.sessionId.isNotBlank() && m.sessionId != sessionId) return
                _state.update { s ->
                    if (s.messages.any { it.id == m.id }) return@update s
                    // Drop our optimistic echo / promoted stream text once the committed row lands.
                    val list = s.messages.filterNot { it.role == m.role && it.text == m.text && (it.id.startsWith("local-") || it.id.startsWith("stream-")) }
                    s.copy(
                        messages = list + m,
                        pendingText = if (m.role == "assistant") "" else s.pendingText,
                        working = if (m.role == "assistant") null else s.working,
                    )
                }
                if (m.role == "assistant") {
                    doneTimer?.cancel(); workingTimer?.cancel()
                    viewModelScope.launch { c.settings.markSeen(bot.id, m.ts) }
                }
            }
            is SessionFrame.Stream -> {
                if (f.session.isNotBlank() && f.session != sessionId) return
                onStream(f)
            }
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
            "error" -> { workingTimer?.cancel(); _state.update { it.copy(error = e.content, working = null) } }
            "done" -> {
                workingTimer?.cancel()
                _state.update { it.copy(working = null) }
                // The committed message frame normally follows; if it never does,
                // promote the streamed text so the reply isn't lost. The promoted
                // row is dropped again if the real frame shows up later.
                doneTimer?.cancel()
                doneTimer = viewModelScope.launch {
                    delay(1500)
                    _state.update { s ->
                        if (s.pendingText.isBlank() || s.messages.lastOrNull()?.role == "assistant") s.copy(pendingText = "")
                        else s.copy(
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
                c.gateways.get(bot.denUrl).post(sid, t, p.handle, bot.sendAgent)
                armWorkingTimeout(sid)
            } catch (e: Exception) {
                _state.update { s -> s.copy(messages = s.messages.filter { it.id != local.id }, error = BotRepository.friendly(e), working = null) }
            }
        }
    }

    /** A turn that produces no frames (WS down, harness died) must not spin forever. */
    private fun armWorkingTimeout(sid: String) {
        workingTimer?.cancel()
        workingTimer = viewModelScope.launch {
            delay(WORKING_TIMEOUT_MS)
            if (_state.value.sessionId != sid) return@launch
            // One last transcript read — the reply may have committed while the socket was down.
            fetch(sid).join()
            _state.update { s ->
                if (s.working == null) s
                else s.copy(working = null, error = "No reply from ${bot.displayName} after ${WORKING_TIMEOUT_MS / 60_000} min — pull to refresh or try again.")
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    /** Start a fresh thread with this bot (old one stays on the node). */
    fun newConversation() {
        val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
        val sid = bot.defaultSessionId(c.identity.deviceTag()) + "-" + stamp + "-" + UUID.randomUUID().toString().take(4)
        viewModelScope.launch {
            c.settings.setSessionOverride(bot.id, sid) // persisted before anything else keys on it
            open(sid)
        }
    }

    override fun onCleared() { watch?.close() }

    companion object { const val WORKING_TIMEOUT_MS = 5 * 60_000L }
}

/**
 * Server transcript wins; live rows survive only if the server hasn't got them
 * yet, and optimistic/promoted rows are dropped once their committed twin shows.
 */
internal fun mergeTranscript(server: List<SessionMessage>, live: List<SessionMessage>): List<SessionMessage> {
    val ids = server.map { it.id }.toHashSet()
    val texts = server.map { it.role to it.text }.toHashSet()
    val keep = live.filter { m ->
        m.id !in ids && !((m.id.startsWith("local-") || m.id.startsWith("stream-")) && (m.role to m.text) in texts)
    }
    return (server + keep).sortedBy { it.ts }
}
