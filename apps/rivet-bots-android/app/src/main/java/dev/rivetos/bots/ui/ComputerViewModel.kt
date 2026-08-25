package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.data.DenFrame
import dev.rivetos.bots.data.Gateway
import dev.rivetos.bots.data.GatewayException
import dev.rivetos.bots.data.OscFilter
import dev.rivetos.bots.data.RoomState
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable

enum class ComputerTab { Activity, Terminal, Desktop }

enum class TermAttach { Idle, Connecting, Attached, Exited, Closed, Disabled, Error }

/** The bot's "computer": den RoomState, a live PTY, and the household desktop URL. */
class ComputerViewModel(private val c: AppContainer, val bot: Bot, val sessionId: String) : ViewModel() {
    data class UiState(
        val room: RoomState? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val loaded: Boolean = false,
        val error: String? = null,
        val tab: ComputerTab = ComputerTab.Activity,
        val desktopUrl: String = "",
        val termStatus: TermAttach = TermAttach.Idle,
        val termWs: WsStatus = WsStatus.CLOSED,
        val termError: String? = null,
        val termCommand: String? = null,
        val termExit: Int? = null,
        val termRev: Int = 0,
        val ptyId: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    val screen = AnsiScreen()

    private var watch: Closeable? = null
    private var refetch: Job? = null
    private var termWatch: TermWs? = null
    private var termStart: Job? = null
    private var resizeJob: Job? = null
    @Volatile private var lastCols = 80
    @Volatile private var lastRows = 24

    init {
        val gw = try { c.gateways.get(bot.denUrl) } catch (e: Exception) { null }
        if (gw == null) {
            _state.update {
                it.copy(
                    loaded = true,
                    error = c.identity.lastError?.let { err -> "device certificate failed to load: $err" } ?: "no gateway",
                )
            }
        } else {
            load()
            watch = gw.watchDen(sessionId, onFrame = { f ->
                when (f) {
                    // Only this thread's room — never another session's screen.
                    is DenFrame.Snapshot -> _state.update {
                        val r = f.rooms[sessionId]
                        it.copy(room = r ?: it.room, loaded = true, error = if (r != null) null else it.error)
                    }
                    is DenFrame.Event -> {
                        if (f.session.isNotBlank() && f.session != sessionId) return@watchDen
                        refetch?.cancel()
                        refetch = viewModelScope.launch { delay(250); load() }
                    }
                }
            }, onStatus = { s -> _state.update { it.copy(ws = s) } })
        }
        viewModelScope.launch {
            c.settings.prefs.collect { p -> _state.update { it.copy(desktopUrl = p.desktopUrl) } }
        }
    }

    fun selectTab(tab: ComputerTab) {
        _state.update { it.copy(tab = tab) }
        if (tab == ComputerTab.Terminal) ensureTerm()
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

    private fun ensureTerm() {
        if (termWatch != null || termStart?.isActive == true) return
        if (_state.value.termStatus == TermAttach.Disabled) return
        termStart = viewModelScope.launch { startTerm() }
    }

    private suspend fun startTerm() {
        val gw = gateway() ?: return
        _state.update { it.copy(termStatus = TermAttach.Connecting, termError = null) }
        try {
            val cfg = gw.termConfig()
            if (!cfg.enabled) {
                _state.update { it.copy(termStatus = TermAttach.Disabled, termError = "Terminals are off on this node.") }
                return
            }
            val spawn = gw.termSpawn(sessionId, lastCols, lastRows)
            _state.update { it.copy(ptyId = spawn.id, termCommand = spawn.command) }
            attach(gw, spawn.id)
        } catch (e: Exception) {
            _state.update { it.copy(termStatus = TermAttach.Error, termError = BotRepository.friendly(e)) }
        }
    }

    private fun attach(gw: Gateway, ptyId: String) {
        termWatch?.close()
        screen.reset(lastCols, lastRows)
        bumpTerm()
        val socket = gw.watchTerm(
            ptyId = ptyId,
            sessionId = null,
            onText = { text -> onTermText(text) },
            onBinary = { bytes ->
                screen.feed(bytes)
                bumpTerm()
            },
            onStatus = { s ->
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

    private fun load() {
        viewModelScope.launch {
            try {
                val room = c.gateways.get(bot.denUrl).denState(sessionId)
                _state.update { it.copy(room = room ?: it.room, loaded = true, error = null) }
            } catch (e: GatewayException) {
                if (e.status == 404) _state.update { it.copy(loaded = true, error = null) }
                else _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            } catch (e: Exception) {
                _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            }
        }
    }

    override fun onCleared() {
        watch?.close()
        termWatch?.close() // detach — never kill; the manager's TTL owns the PTY
    }
}
