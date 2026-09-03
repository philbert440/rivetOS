package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.BotEdit
import io.rivethub.app.data.BotRepository
import io.rivethub.app.data.SessionResolver
import io.rivethub.app.data.effective
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.data.visibleAssistantText
import io.rivethub.app.domain.Bot
import io.rivethub.app.gateway.Gateway
import io.rivethub.app.gateway.SessionFrame
import io.rivethub.app.gateway.SessionMessage
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.transport.toNodeRef
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.coroutineContext

/** One bot thread. [initialSessionId] comes from the persisted prefs the caller already holds. */
class ChatViewModel(private val c: AppContainer, val bot: Bot, initialSessionId: String) : ViewModel() {
    data class UiState(
        val sessionId: String,
        val messages: List<SessionMessage> = emptyList(),
        val pendingText: String = "",
        /** Unsplit stream buffer so a Hermes box that arrives in chunks is peeled as a whole. */
        val pendingRaw: String = "",
        val working: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val error: String? = null,
        val loading: Boolean = true,
        /** Bumped on every committed assistant row — the done-promoter compares against it. */
        val assistantSeq: Int = 0,
        /** True from send until the reply commits (or is promoted / errors / times out). */
        val inFlight: Boolean = false,
        /** The text of the turn in flight — its committed row anchors "a reply that follows it". */
        val turnText: String = "",
    ) {
        val canSend: Boolean get() = !inFlight && !loading
    }

    private val _state = MutableStateFlow(UiState(initialSessionId))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var watch: Closeable? = null
    private var doneTimer: Job? = null
    private var workingTimer: Job? = null
    private var fetchJob: Job? = null
    @Volatile private var everOpen = false
    @Volatile private var botEdits: Map<String, BotEdit> = emptyMap()

    init {
        viewModelScope.launch { c.settings.prefs.collect { botEdits = it.botEdits } }
        viewModelScope.launch { adoptThenOpen(initialSessionId) }
    }

    private fun shownName(): String = bot.effective(botEdits[bot.id]).displayName

    private suspend fun adoptThenOpen(hint: String) {
        val prefs = c.settings.snapshot()
        val minted = bot.defaultSessionId(c.identity.deviceTag())
        val pick = try {
            c.bots.resolveSessionId(bot, prefs.sessionOverrides[bot.id], minted)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            coroutineContext.ensureActive()
            open(prefs.sessionOverrides[bot.id] ?: hint)
            return
        }
        coroutineContext.ensureActive()
        // A New conversation tap during the fetch already wrote an override — keep it.
        val now = c.settings.snapshot().sessionOverrides[bot.id]
        if (!now.isNullOrBlank() && now != prefs.sessionOverrides[bot.id]) {
            open(now)
            return
        }
        if (pick.persist) c.settings.setSessionOverride(bot.id, pick.id)
        coroutineContext.ensureActive()
        open(pick.id)
    }

    /** The node's gateway, or null (with the error surfaced) when the device identity won't load. */
    private fun gateway(): Gateway? = try {
        c.transport.gateway(bot.toNodeRef())
    } catch (e: Exception) {
        _state.update { it.copy(error = BotRepository.friendly(e), loading = false, working = null, inFlight = false) }
        null
    }

    fun open(sessionId: String) {
        if (sessionId == _state.value.sessionId && watch != null) return
        watch?.close()
        doneTimer?.cancel(); workingTimer?.cancel(); fetchJob?.cancel()
        everOpen = false
        _state.update { UiState(sessionId) }
        val gw = gateway() ?: return
        fetchJob = fetch(sessionId)
        watch = gw.watchSessions(
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

    /**
     * Transcript read merged with live rows. The turn closes only when the
     * server transcript holds a NEW assistant row that comes AFTER our own
     * committed user row — server ordering, so device clock skew can't hold a
     * finished turn open, and a history that merely ends on the previous
     * reply proves nothing.
     */
    private fun fetch(sessionId: String): Job = viewModelScope.launch {
        try {
            val raw = (gateway() ?: return@launch).messages(sessionId)
            val msgs = raw.map { sanitizeMessage(it) }.filter { it.role != "assistant" || it.text.isNotBlank() || !it.tools.isNullOrEmpty() }
            if (_state.value.sessionId != sessionId) return@launch
            var closed = false
            _state.update { s ->
                val known = s.messages.map { it.id }.toHashSet()
                val merged = mergeTranscript(msgs, s.messages)
                val mine = raw.indexOfLast { it.role == "user" && it.text == s.turnText }
                val replied = s.inFlight && mine >= 0 &&
                    raw.drop(mine + 1).any { it.role == "assistant" && it.id !in known } &&
                    raw.lastOrNull()?.role == "assistant"
                closed = replied
                s.copy(
                    messages = merged, loading = false,
                    pendingText = if (replied) "" else s.pendingText,
                    pendingRaw = if (replied) "" else s.pendingRaw,
                    working = if (replied) null else s.working,
                    inFlight = if (replied) false else s.inFlight,
                    // Historical rows are not "this turn's reply" — seq moves only when we accept one.
                    assistantSeq = if (replied) s.assistantSeq + 1 else s.assistantSeq,
                )
            }
            if (closed) { doneTimer?.cancel(); workingTimer?.cancel() }
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
                val incoming = f.message
                val m = if (incoming.role == "assistant") incoming.copy(text = visibleAssistantText(incoming.text)) else incoming
                if (m.sessionId.isNotBlank() && m.sessionId != sessionId) return
                if (m.role == "assistant" && m.text.isBlank() && m.tools.isNullOrEmpty()) {
                    doneTimer?.cancel(); workingTimer?.cancel()
                    _state.update { it.copy(pendingText = "", pendingRaw = "", working = null, inFlight = false, assistantSeq = it.assistantSeq + 1) }
                    return
                }
                _state.update { s ->
                    if (s.messages.any { it.id == m.id }) return@update s
                    // Drop ONE optimistic echo / promoted row that this committed row confirms.
                    val twin = s.messages.indexOfFirst { it.role == m.role && it.text == m.text && (it.id.startsWith("local-") || it.id.startsWith("stream-")) }
                    val list = if (twin >= 0) s.messages.toMutableList().also { it.removeAt(twin) } else s.messages
                    val assistant = m.role == "assistant"
                    s.copy(
                        messages = list + m,
                        pendingText = if (assistant) "" else s.pendingText,
                        pendingRaw = if (assistant) "" else s.pendingRaw,
                        working = if (assistant) null else s.working,
                        inFlight = if (assistant) false else s.inFlight,
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
        if (e.type != "done" && e.type != "error") armWorkingTimeout(_state.value.sessionId) // liveness: any frame resets the idle deadline
        when (e.type) {
            "text" -> _state.update {
                val raw = it.pendingRaw + e.content
                val split = splitHermesReasoning(raw)
                it.copy(
                    pendingRaw = raw,
                    pendingText = split.text,
                    working = if (split.reasoning.isNotEmpty()) "Thinking…" else null,
                )
            }
            "reasoning" -> _state.update { it.copy(working = "Thinking…") }
            "tool_start" -> _state.update { it.copy(working = "Using ${e.content.ifBlank { "a tool" }}") }
            "tool_result" -> _state.update { it.copy(working = "Working…") }
            "status" -> _state.update { it.copy(working = e.content.ifBlank { it.working }) }
            "error" -> { workingTimer?.cancel(); doneTimer?.cancel(); _state.update { it.copy(error = e.content, working = null, inFlight = false, pendingText = "", pendingRaw = "") } }
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
                        when {
                            s.assistantSeq != seqAtDone -> s.copy(pendingText = "", pendingRaw = "", inFlight = false) // the real row landed
                            s.pendingText.isBlank() -> s.copy(inFlight = false, pendingRaw = "")   // empty turn (tool-only) — release the composer
                            else -> s.copy(
                                messages = s.messages + SessionMessage(
                                    id = "stream-${UUID.randomUUID()}", sessionId = s.sessionId,
                                    role = "assistant", text = s.pendingText, ts = System.currentTimeMillis(),
                                ),
                                pendingText = "", pendingRaw = "", inFlight = false, assistantSeq = s.assistantSeq + 1,
                            )
                        }
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
        doneTimer?.cancel() // a promoter still pending from the previous turn must not touch this one's stream
        val now = System.currentTimeMillis()
        val local = SessionMessage(id = "local-${UUID.randomUUID()}", sessionId = sid, role = "user", text = t, ts = now)
        _state.update { it.copy(messages = it.messages + local, error = null, working = "${shownName()} is working…", inFlight = true, turnText = t) }
        viewModelScope.launch {
            try {
                val p = c.settings.snapshot()
                (gateway() ?: throw IllegalStateException(_state.value.error ?: "no gateway")).post(sid, t, p.handle, bot.sendAgent)
                armWorkingTimeout(sid)
            } catch (e: Exception) {
                _state.update { s -> s.copy(messages = s.messages.filter { it.id != local.id }, error = BotRepository.friendly(e), working = null, inFlight = false) }
            }
        }
    }

    /**
     * Idle deadline, not a wall clock: (re)armed on send and on every stream
     * frame, so a long tool-heavy turn never trips it while it's still talking.
     * A turn that goes silent (socket down, harness died) gets an early
     * transcript re-read when the WS isn't open, then a final one at the
     * deadline before we give up.
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
                if (!s.inFlight) s
                else s.copy(working = null, inFlight = false, error = "${shownName()} went quiet for ${WORKING_TIMEOUT_MS / 60_000} min. Try again.")
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    /** Start a fresh thread with this bot (old one stays on the node). */
    fun newConversation() {
        val sid = SessionResolver.newSessionId(
            bot.defaultSessionId(c.identity.deviceTag()),
            SessionResolver.newStamp(),
            UUID.randomUUID().toString().take(4),
        )
        viewModelScope.launch {
            c.settings.setSessionOverride(bot.id, sid) // persisted before anything else keys on it
            open(sid)
        }
    }

    override fun onCleared() { watch?.close() }

    companion object { const val WORKING_TIMEOUT_MS = 3 * 60_000L }
}

internal fun sanitizeMessage(m: SessionMessage): SessionMessage =
    if (m.role == "assistant") m.copy(text = visibleAssistantText(m.text)) else m

/**
 * Server transcript wins. Live rows survive only if the server hasn't got them
 * yet. An optimistic send (`local-`) or promoted reply (`stream-`) is dropped
 * once — and only once — a committed row with the same role+text can claim
 * it, so two identical sends (or replies) keep two bubbles until both commit.
 */
internal fun mergeTranscript(server: List<SessionMessage>, live: List<SessionMessage>): List<SessionMessage> {
    val ids = server.map { it.id }.toHashSet()
    val claims = HashMap<Pair<String, String>, Int>()
    for (m in server) claims.merge(m.role to m.text, 1, Int::plus)
    // Committed live rows (ids the server also has) already consume their claim.
    for (m in live) if (m.id in ids) claims.merge(m.role to m.text, -1, Int::plus)
    val keep = live.filter { m ->
        if (m.id in ids) return@filter false
        if (!(m.id.startsWith("local-") || m.id.startsWith("stream-"))) return@filter true
        val key = m.role to m.text
        val left = claims[key] ?: 0
        if (left > 0) { claims[key] = left - 1; false } else true
    }
    return (server + keep).sortedBy { it.ts }
}
