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

/**
 * One bot thread. The session id is resolved from persisted prefs (not an
 * in-memory copy) so a "new conversation" started elsewhere is honoured on
 * the next open; pass [initialSessionId] to pin a specific thread.
 */
class ChatViewModel(private val c: AppContainer, val bot: Bot, initialSessionId: String? = null) : ViewModel() {
    data class UiState(
        val sessionId: String,
        val messages: List<SessionMessage> = emptyList(),
        val pendingText: String = "",
        val working: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val error: String? = null,
        val loading: Boolean = true,
        /** Bumped on every committed assistant row — the done-promoter compares against it. */
        val assistantSeq: Int = 0,
    ) {
        val canSend: Boolean get() = working == null && !loading
    }

    private val _state = MutableStateFlow(UiState(initialSessionId ?: bot.defaultSessionId(c.identity.deviceTag())))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var watch: Closeable? = null
    private var doneTimer: Job? = null
    private var workingTimer: Job? = null
    private var fetchJob: Job? = null
    private var everOpen = false

    init {
        if (initialSessionId != null) open(initialSessionId)
        else viewModelScope.launch { open(resolveSessionId()) }
    }

    private suspend fun resolveSessionId(): String =
        c.settings.snapshot().sessionOverrides[bot.id] ?: bot.defaultSessionId(c.identity.deviceTag())

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
                if (_state.value.sessionId != sessionId) return@watchSessions
                _state.update { it.copy(ws = s) }
                // The ring is process-local and the WS has no replay: after a
                // reconnect, re-read the transcript to pick up anything missed.
                if (s == WsStatus.OPEN) { if (everOpen) fetchJob = fetch(sessionId) else everOpen = true }
            },
        )
    }

    /** Transcript read merged with live rows; a transcript ending in a reply closes the turn. */
    private fun fetch(sessionId: String): Job = viewModelScope.launch {
        try {
            val msgs = c.gateways.get(bot.denUrl).messages(sessionId)
            if (_state.value.sessionId != sessionId) return@launch
            _state.update { s ->
                val merged = mergeTranscript(msgs, s.messages)
                val replied = merged.lastOrNull()?.role == "assistant"
                s.copy(
                    messages = merged, loading = false,
                    pendingText = if (replied) "" else s.pendingText,
                    working = if (replied) null else s.working,
                    assistantSeq = if (replied) s.assistantSeq + 1 else s.assistantSeq,
                )
            }
            if (_state.value.working == null) { doneTimer?.cancel(); workingTimer?.cancel() }
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
                    // Drop ONE optimistic echo / promoted row that this committed row confirms.
                    val twin = s.messages.indexOfFirst { it.role == m.role && it.text == m.text && (it.id.startsWith("local-") || it.id.startsWith("stream-")) }
                    val list = if (twin >= 0) s.messages.toMutableList().also { it.removeAt(twin) } else s.messages
                    val assistant = m.role == "assistant"
                    s.copy(
                        messages = list + m,
                        pendingText = if (assistant) "" else s.pendingText,
                        working = if (assistant) null else s.working,
                        assistantSeq = if (assistant) s.assistantSeq + 1 else s.assistantSeq,
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
                // The committed message frame normally follows `done`. If none has
                // landed 1.5s later, promote the streamed text so the reply isn't
                // lost; the promoted row is swapped out if the real frame shows up.
                val seqAtDone = _state.value.assistantSeq
                doneTimer?.cancel()
                doneTimer = viewModelScope.launch {
                    delay(1500)
                    _state.update { s ->
                        if (s.assistantSeq != seqAtDone || s.pendingText.isBlank()) s.copy(pendingText = if (s.assistantSeq != seqAtDone) "" else s.pendingText)
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

    /** One turn in flight per thread — the composer disables send while [UiState.canSend] is false. */
    fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty() || !_state.value.canSend) return
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

    /**
     * A turn that produces no frames (socket down, harness died) must not spin
     * forever: re-read the transcript early when the WS isn't open, then again
     * at the deadline before giving up.
     */
    private fun armWorkingTimeout(sid: String) {
        workingTimer?.cancel()
        workingTimer = viewModelScope.launch {
            delay(3_000)
            if (_state.value.sessionId == sid && _state.value.ws != WsStatus.OPEN) fetch(sid).join()
            delay(WORKING_TIMEOUT_MS - 3_000)
            if (_state.value.sessionId != sid) return@launch
            fetch(sid).join() // the reply may have committed while the socket was down
            _state.update { s ->
                if (s.working == null) s
                else s.copy(working = null, error = "No reply from ${bot.displayName} after ${WORKING_TIMEOUT_MS / 60_000} min. Try again.")
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

    companion object { const val WORKING_TIMEOUT_MS = 3 * 60_000L }
}

/**
 * Server transcript wins. Live rows survive only if the server hasn't got them
 * yet. A promoted reply (`stream-`) is dropped as soon as the server holds a
 * committed row with the same text; an optimistic send (`local-`) is dropped
 * once — and only once — a committed row with the same text can claim it, so
 * two identical sends keep two bubbles until both commit.
 */
internal fun mergeTranscript(server: List<SessionMessage>, live: List<SessionMessage>): List<SessionMessage> {
    val ids = server.map { it.id }.toHashSet()
    val serverTexts = server.map { it.role to it.text }.toHashSet()
    val claims = HashMap<Pair<String, String>, Int>()
    for (m in server) claims.merge(m.role to m.text, 1, Int::plus)
    // Committed live rows (ids the server also has) already consume their claim.
    for (m in live) if (m.id in ids) claims.merge(m.role to m.text, -1, Int::plus)
    val keep = live.filter { m ->
        if (m.id in ids) return@filter false
        val key = m.role to m.text
        when {
            m.id.startsWith("stream-") -> key !in serverTexts
            m.id.startsWith("local-") -> {
                val left = claims[key] ?: 0
                if (left > 0) { claims[key] = left - 1; false } else true
            }
            else -> true
        }
    }
    return (server + keep).sortedBy { it.ts }
}
