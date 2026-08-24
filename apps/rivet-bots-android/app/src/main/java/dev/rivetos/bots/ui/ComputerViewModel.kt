package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.data.DenFrame
import dev.rivetos.bots.data.DenSessionInfo
import dev.rivetos.bots.data.Gateway
import dev.rivetos.bots.data.GatewayException
import dev.rivetos.bots.data.NodeSession
import dev.rivetos.bots.data.OscFilter
import dev.rivetos.bots.data.RoomState
import dev.rivetos.bots.data.SessionFrame
import dev.rivetos.bots.data.SessionResolver
import dev.rivetos.bots.data.SessionSummary
import dev.rivetos.bots.data.TermFrame
import dev.rivetos.bots.data.TermResizeFrame
import dev.rivetos.bots.data.TermWs
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.data.parseTermFrame
import dev.rivetos.bots.data.wireJson
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.ui.term.AnsiScreen
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

enum class ComputerTab { Terminal, Activity, Desktop }

enum class TermAttach { Idle, Connecting, Attached, Exited, Closed, Disabled, Error }

/**
 * The bot's "computer": den RoomState, a live PTY, and the household desktop URL.
 *
 * Session selection stays inside this VM (`switchSession`) rather than re-keying
 * the nav entry: [ComputerScreen] keeps its public signature, and tearing down
 * den + TermWs + AnsiScreen here is the same work a fresh VM would do without
 * forcing MainActivity to swap storeKeys mid-screen.
 */
class ComputerViewModel(private val c: AppContainer, val bot: Bot, initialSessionId: String) : ViewModel() {
    data class UiState(
        val sessionId: String = "",
        val room: RoomState? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val loaded: Boolean = false,
        val error: String? = null,
        val tab: ComputerTab = ComputerTab.Terminal,
        val desktopUrl: String = "",
        val termStatus: TermAttach = TermAttach.Idle,
        val termWs: WsStatus = WsStatus.CLOSED,
        val termError: String? = null,
        val termCommand: String? = null,
        val termExit: Int? = null,
        val termRev: Int = 0,
        val ptyId: String? = null,
        val sessions: List<NodeSession> = emptyList(),
        val sessionsLoaded: Boolean = false,
        val sessionsError: String? = null,
        val sessionReady: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState(sessionId = initialSessionId))
    val state: StateFlow<UiState> = _state.asStateFlow()

    val screen = AnsiScreen()

    private var watch: Closeable? = null
    private var dirtyWatch: Closeable? = null
    private var refetch: Job? = null
    private var sessionsJob: Job? = null
    private var termWatch: TermWs? = null
    private var termStart: Job? = null
    private var resizeJob: Job? = null
    @Volatile private var lastCols = 80
    @Volatile private var lastRows = 24
    @Volatile private var bindGen = 0
    @Volatile private var currentSession = initialSessionId
    @Volatile private var denNames: List<DenSessionInfo> = emptyList()
    @Volatile private var lastApi: List<SessionSummary> = emptyList()

    init {
        viewModelScope.launch {
            c.settings.prefs.collect { p -> _state.update { it.copy(desktopUrl = p.desktopUrl) } }
        }
        viewModelScope.launch { adoptAndBind() }
    }

    private suspend fun adoptAndBind() {
        val prefs = c.settings.snapshot()
        val minted = bot.defaultSessionId(c.identity.deviceTag())
        val pick = try {
            c.bots.resolveSessionId(bot, prefs.sessionOverrides[bot.id], minted)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loaded = true, error = BotRepository.friendly(e), sessionReady = false) }
            return
        }
        coroutineContext.ensureActive()
        // Activity tap / New session during the fetch already wrote an override — keep it.
        val now = c.settings.snapshot().sessionOverrides[bot.id]
        if (!now.isNullOrBlank() && now != prefs.sessionOverrides[bot.id]) {
            if (currentSession != now || !_state.value.sessionReady) {
                bind(now)
                if (_state.value.tab == ComputerTab.Terminal) ensureTerm()
            }
            refreshSessions()
            return
        }
        if (pick.persist) c.settings.setSessionOverride(bot.id, pick.id)
        coroutineContext.ensureActive()
        bind(pick.id)
        refreshSessions()
        ensureTerm()
    }

    /**
     * Close den/term, reset the VT, reopen watches for [id]. Generation-guarded
     * so a fast tap can't let a stale spawn attach to the previous session.
     */
    fun switchSession(id: String) {
        val next = id.trim()
        if (next.isEmpty() || (next == currentSession && _state.value.sessionReady)) return
        viewModelScope.launch {
            c.settings.setSessionOverride(bot.id, next)
            bind(next)
            if (_state.value.tab == ComputerTab.Terminal) ensureTerm()
        }
    }

    fun newSession() {
        val sid = SessionResolver.newSessionId(
            bot.defaultSessionId(c.identity.deviceTag()),
            SessionResolver.newStamp(),
            UUID.randomUUID().toString().take(4),
        )
        switchSession(sid)
    }

    fun selectTab(tab: ComputerTab) {
        _state.update { it.copy(tab = tab) }
        if (tab == ComputerTab.Terminal) ensureTerm()
        if (tab == ComputerTab.Activity) refreshSessions()
    }

    fun retryTerm() {
        termWatch?.close()
        termWatch = null
        termStart?.cancel()
        _state.update { it.copy(termStatus = TermAttach.Idle, termError = null, ptyId = null) }
        ensureTerm()
    }

    fun onTermSize(cols: Int, rows: Int) {
        val cCols = cols.coerceIn(AnsiScreen.MIN_COLS, AnsiScreen.MAX_COLS)
        val cRows = rows.coerceIn(AnsiScreen.MIN_ROWS, AnsiScreen.MAX_ROWS)
        if (cCols == lastCols && cRows == lastRows) return
        lastCols = cCols
        lastRows = cRows
        screen.resize(cCols, cRows)
        bumpTerm()
        resizeJob?.cancel()
        resizeJob = viewModelScope.launch {
            delay(150)
            sendResize()
        }
    }

    fun sendInput(text: String) {
        if (text.isEmpty()) return
        if (OscFilter.isColorReport(text)) return
        val normalized = text.replace("\n", "\r")
        termWatch?.sendBinary(normalized.toByteArray(Charsets.UTF_8))
    }

    fun sendControl(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        termWatch?.sendBinary(bytes)
    }

    fun setDesktopUrl(url: String) {
        viewModelScope.launch { c.settings.setDesktopUrl(url) }
    }

    fun ensureTerm() {
        if (!_state.value.sessionReady) return
        if (termWatch != null || termStart?.isActive == true) return
        if (_state.value.termStatus == TermAttach.Disabled) return
        termStart = viewModelScope.launch { startTerm() }
    }

    fun refreshSessions() {
        sessionsJob?.cancel()
        sessionsJob = viewModelScope.launch {
            delay(150)
            try {
                lastApi = c.bots.nodeSessions(bot)
                _state.update {
                    it.copy(
                        sessions = SessionResolver.merge(lastApi, denNames),
                        sessionsLoaded = true,
                        sessionsError = null,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        sessionsLoaded = true,
                        sessionsError = BotRepository.friendly(e),
                        sessions = SessionResolver.merge(lastApi, denNames),
                    )
                }
            }
        }
    }

    private fun bind(id: String) {
        val gen = ++bindGen
        watch?.close(); watch = null
        refetch?.cancel()
        tearDownTerm()
        currentSession = id
        screen.reset(lastCols, lastRows)
        _state.update {
            it.copy(
                sessionId = id,
                room = null,
                loaded = false,
                error = null,
                ws = WsStatus.CONNECTING,
                termStatus = TermAttach.Idle,
                termWs = WsStatus.CLOSED,
                termError = null,
                termCommand = null,
                termExit = null,
                ptyId = null,
                termRev = screen.generation,
                sessionReady = true,
            )
        }
        val gw = try { c.gateways.get(bot.denUrl) } catch (e: Exception) {
            _state.update {
                it.copy(
                    loaded = true,
                    sessionReady = false,
                    error = c.identity.lastError?.let { err -> "device certificate failed to load: $err" }
                        ?: BotRepository.friendly(e),
                )
            }
            return
        }
        openDirtyWatch(gw)
        watch = gw.watchDen(id, onFrame = { f ->
            if (gen != bindGen) return@watchDen
            when (f) {
                is DenFrame.Snapshot -> {
                    denNames = f.sessions
                    _state.update {
                        val r = f.rooms[id]
                        it.copy(
                            room = r ?: it.room,
                            loaded = true,
                            error = if (r != null) null else it.error,
                            sessions = SessionResolver.merge(lastApi, denNames),
                        )
                    }
                }
                is DenFrame.Event -> {
                    if (f.session.isNotBlank() && f.session != id) return@watchDen
                    refetch?.cancel()
                    refetch = viewModelScope.launch { delay(250); if (gen == bindGen) load(id, gen) }
                    if (sessionLifecycleEvent(f.type)) refreshSessions()
                }
            }
        }, onStatus = { s -> if (gen == bindGen) _state.update { it.copy(ws = s) } })
        load(id, gen)
    }

    /** session.start / session.end / session.removed — not tool/activity chatter. */
    private fun sessionLifecycleEvent(type: String): Boolean =
        type.startsWith("session", ignoreCase = true)

    private fun openDirtyWatch(gw: Gateway) {
        if (dirtyWatch != null) return
        dirtyWatch = gw.watchSessions(null, onFrame = { f ->
            if (f is SessionFrame.SessionsDirty) refreshSessions()
        })
    }

    private fun tearDownTerm() {
        termStart?.cancel(); termStart = null
        resizeJob?.cancel()
        termWatch?.close(); termWatch = null
    }

    private suspend fun startTerm() {
        val gen = bindGen
        val sid = currentSession
        val gw = gateway() ?: return
        _state.update { it.copy(termStatus = TermAttach.Connecting, termError = null) }
        try {
            val cfg = gw.termConfig()
            if (!cfg.enabled) {
                _state.update { it.copy(termStatus = TermAttach.Disabled, termError = "Terminals are off on this node.") }
                return
            }
            val spawn = gw.termSpawn(sid, lastCols, lastRows)
            if (gen != bindGen) return
            _state.update { it.copy(ptyId = spawn.id, termCommand = spawn.command) }
            attach(gw, spawn.id, gen)
        } catch (e: Exception) {
            if (gen != bindGen) return
            _state.update { it.copy(termStatus = TermAttach.Error, termError = BotRepository.friendly(e)) }
        }
    }

    private fun attach(gw: Gateway, ptyId: String, gen: Int) {
        if (gen != bindGen) return
        termWatch?.close()
        screen.reset(lastCols, lastRows)
        bumpTerm()
        val socket = gw.watchTerm(
            ptyId = ptyId,
            sessionId = null,
            onText = { text -> if (gen == bindGen) onTermText(text) },
            onBinary = { bytes ->
                if (gen != bindGen) return@watchTerm
                screen.feed(bytes)
                bumpTerm()
            },
            onStatus = { s ->
                if (gen != bindGen) return@watchTerm
                _state.update { st ->
                    val attach = when {
                        st.termStatus == TermAttach.Exited -> TermAttach.Exited
                        st.termStatus == TermAttach.Disabled || st.termStatus == TermAttach.Error -> st.termStatus
                        s == WsStatus.OPEN -> TermAttach.Attached
                        s == WsStatus.CONNECTING -> TermAttach.Connecting
                        else -> TermAttach.Closed
                    }
                    st.copy(termWs = s, termStatus = attach)
                }
            },
        )
        if (gen != bindGen) { socket.close(); return }
        termWatch = socket
    }

    private fun onTermText(text: String) {
        when (val f = parseTermFrame(text)) {
            is TermFrame.Hello -> {
                // Reconnect replays scrollback next — drop whatever we painted last time.
                screen.reset(lastCols, lastRows)
                bumpTerm()
                if (f.frame.cols != lastCols || f.frame.rows != lastRows) sendResize()
                val exited = f.frame.state == "exited"
                if (exited) termWatch?.reconnectOnClose = false
                _state.update {
                    it.copy(
                        termStatus = if (exited) TermAttach.Exited else TermAttach.Attached,
                        termCommand = f.frame.command.ifBlank { it.termCommand },
                        termExit = if (exited) f.frame.exitCode else it.termExit,
                        ptyId = f.frame.id.ifBlank { it.ptyId },
                    )
                }
            }
            is TermFrame.Exit -> {
                termWatch?.reconnectOnClose = false
                val code = f.frame.code
                screen.feed("\r\n\u001b[2m[process exited ${code ?: "?"}]\u001b[0m\r\n".toByteArray(Charsets.UTF_8))
                bumpTerm()
                _state.update { it.copy(termStatus = TermAttach.Exited, termExit = code) }
            }
            null -> {}
        }
    }

    private fun sendResize() {
        val socket = termWatch ?: return
        socket.sendText(wireJson.encodeToString(TermResizeFrame.serializer(), TermResizeFrame(cols = lastCols, rows = lastRows)))
    }

    private fun bumpTerm() {
        _state.update { it.copy(termRev = screen.generation) }
    }

    private fun gateway(): Gateway? = try {
        c.gateways.get(bot.denUrl)
    } catch (e: Exception) {
        _state.update { it.copy(termStatus = TermAttach.Error, termError = BotRepository.friendly(e)) }
        null
    }

    private fun load(sessionId: String, gen: Int) {
        viewModelScope.launch {
            try {
                val room = c.gateways.get(bot.denUrl).denState(sessionId)
                if (gen != bindGen) return@launch
                _state.update { it.copy(room = room ?: it.room, loaded = true, error = null) }
            } catch (e: GatewayException) {
                if (gen != bindGen) return@launch
                if (e.status == 404) _state.update { it.copy(loaded = true, error = null) }
                else _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            } catch (e: Exception) {
                if (gen != bindGen) return@launch
                _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            }
        }
    }

    override fun onCleared() {
        watch?.close()
        dirtyWatch?.close()
        termWatch?.close() // detach — never kill; the manager's TTL owns the PTY
    }
}
