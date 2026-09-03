package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.data.OscFilter
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.gateway.TermFrame
import io.rivethub.app.gateway.TermWs
import io.rivethub.app.gateway.UserTurn
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.parseTermFrame
import io.rivethub.app.gateway.sessionKeyEnc
import io.rivethub.app.plane.AskUserCard
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.CLOSED_GATE
import io.rivethub.app.plane.ChatItem
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.EnqueueResult
import io.rivethub.app.plane.HarnessGate
import io.rivethub.app.plane.HarnessSheet
import io.rivethub.app.plane.LiveTool
import io.rivethub.app.plane.OutboundPump
import io.rivethub.app.plane.PendingAttachment
import io.rivethub.app.plane.SessionAttach
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TranscriptMachine
import io.rivethub.app.plane.anyUploading
import io.rivethub.app.plane.cardFromLiveTools
import io.rivethub.app.plane.composeAskAnswer
import io.rivethub.app.plane.defaultEffort
import io.rivethub.app.plane.defaultModel
import io.rivethub.app.plane.effortListFor
import io.rivethub.app.plane.harnessGate
import io.rivethub.app.plane.parseSessionMode
import io.rivethub.app.plane.persistSessionMode
import io.rivethub.app.plane.TermKeys
import io.rivethub.app.plane.TermPtyClient
import io.rivethub.app.plane.TermSink
import io.rivethub.app.plane.readyUris
import io.rivethub.app.plane.renderAttachCommand
import io.rivethub.app.plane.rosterCommandFor
import io.rivethub.app.plane.spawnModelEffort
import io.rivethub.app.plane.toSheet
import io.rivethub.app.plane.uploadBaseUrl
import io.rivethub.app.plane.withAttachmentText
import io.rivethub.app.ui.term.AnsiScreen
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable
import java.util.UUID

class HarnessChatViewModel(
    private val c: AppContainer,
    initialSessionKey: String,
    private val nodeDenUrl: String,
    private val harnessId: String?,
    initialTitle: String,
    initialDraft: Boolean,
) : ViewModel() {
    data class UiState(
        val title: String,
        val sessionId: String,
        val draft: Boolean,
        val mode: SessionMode = SessionMode.Chat,
        val model: String = "",
        val effort: String = "",
        val nodeName: String,
        val nodeDenUrl: String,
        val turns: List<HarnessTranscriptTurn> = emptyList(),
        val liveText: String = "",
        val liveReasoning: String = "",
        val inFlight: Boolean = false,
        val ask: AskUserCard? = null,
        val composer: String = "",
        val attachments: List<PendingAttachment> = emptyList(),
        val sheet: HarnessSheet? = null,
        val gate: HarnessGate = CLOSED_GATE,
        val error: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val moreOpen: Boolean = false,
        val termStatus: String = "closed",
        val termRev: Int = 0,
        val termFontSp: Int = 13,
        val attachCommand: String? = null,
        val termClipboard: String? = null,
    )

    private val _state = MutableStateFlow(
        UiState(
            title = initialTitle,
            sessionId = initialSessionKey,
            draft = initialDraft,
            nodeName = hostOfUrl(nodeDenUrl),
            nodeDenUrl = nodeDenUrl,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val machine = TranscriptMachine(nowMs = { System.currentTimeMillis() })
    private val liveTools = ArrayList<LiveTool>()
    private var attach: SessionAttach? = null
    private var sessionWatch: Closeable? = null
    private var registryWatch: Closeable? = null
    private val identityGen = c.identity.generation()
    private var spawnInFlight = false

    private val termScreen = AnsiScreen()
    private var termWs: TermWs? = null
    private var termClient: TermPtyClient? = null
    private var termAttachJob: Job? = null
    private var termWanted = false
    private var lastTermCols = 80
    private var lastTermRows = 24

    fun terminalScreen(): AnsiScreen = termScreen

    private val pump = OutboundPump(
        send = { text -> actuallySend(text) },
        attachmentsUploading = { anyUploading(_state.value.attachments) },
    )

    private var tick: Job? = null

    init {
        viewModelScope.launch { boot() }
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                _state.update { it.copy(termFontSp = p.terminalFontSp) }
            }
        }
        tick = viewModelScope.launch {
            while (true) {
                delay(15_000)
                if (c.identity.generation() != identityGen) {
                    detachTerminal(keepWanted = false)
                    return@launch
                }
                if (machine.idleTimedOut()) {
                    machine.onFrame(HarnessEvent.Error(_state.value.sessionId, "idle_timeout", "turn timed out"))
                    publishMachine()
                }
                if (pump.isStalled()) runCatching { pump.onTurnComplete() }
            }
        }
    }

    fun setComposer(v: String) = _state.update { it.copy(composer = v) }
    fun setMoreOpen(v: Boolean) = _state.update { it.copy(moreOpen = v) }

    fun setMode(mode: SessionMode) {
        _state.update { it.copy(mode = mode) }
        viewModelScope.launch { c.settings.setSessionMode(_state.value.sessionId, persistSessionMode(mode)) }
    }

    fun setModel(id: String) {
        val sheet = _state.value.sheet
        val effort = defaultEffort(sheet, id)
        _state.update { it.copy(model = id, effort = effort) }
    }

    fun setEffort(id: String) = _state.update { it.copy(effort = id) }

    fun send() {
        val st = _state.value
        if (anyUploading(st.attachments)) return
        val text = withAttachmentText(st.composer.trim(), readyUris(st.attachments))
        if (text.isBlank()) return
        _state.update { it.copy(composer = "", attachments = emptyList(), error = null) }
        when (val r = pump.tryEnqueue(text)) {
            is EnqueueResult.Uploading -> return
            is EnqueueResult.Accepted -> {
                machine.beginTurn()
                publishMachine()
                viewModelScope.launch {
                    runCatching { pump.pump() }.onFailure { e ->
                        _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
                    }
                }
            }
        }
    }

    fun stop() {
        val st = _state.value
        if (!st.gate.canInterrupt || st.draft) return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { c.harness(nodeDenUrl).interrupt(sessionKeyEnc(st.sessionId)) }
        }
    }

    fun answerAsk(picked: Map<Int, List<String>>, free: String) {
        val card = _state.value.ask ?: return
        val text = composeAskAnswer(card.questions, picked, free)
        if (text.isBlank()) return
        _state.update { it.copy(ask = null) }
        liveTools.clear()
        _state.update { it.copy(composer = text) }
        send()
    }

    fun dismissAsk() {
        _state.update { it.copy(ask = null) }
        liveTools.clear()
    }

    fun stageBytes(bytes: ByteArray, name: String, mime: String?) {
        val id = UUID.randomUUID().toString()
        _state.update {
            it.copy(attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.UPLOADING))
        }
        viewModelScope.launch {
            val entry = c.settings.snapshot().entryUrl
            val base = uploadBaseUrl(nodeDenUrl, entry)
            try {
                val staged = withContext(Dispatchers.IO) {
                    c.harness(base).stageUpload(bytes, name, mime)
                }
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.READY, uri = staged.uri) else a
                        },
                    )
                }
            } catch (e: Exception) {
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.FAILED) else a
                        },
                        error = e.message ?: e.javaClass.simpleName,
                    )
                }
            }
        }
    }

    fun removeAttachment(id: String) {
        _state.update { it.copy(attachments = it.attachments.filter { a -> a.id != id }) }
    }

    override fun onCleared() {
        tick?.cancel()
        sessionWatch?.close()
        registryWatch?.close()
        attach?.stop("leave")
        detachTerminal(keepWanted = false)
        super.onCleared()
    }

    fun ensureTerminal() {
        termWanted = true
        if (c.identity.generation() != identityGen) return
        if (termWs != null) return
        if (termAttachJob?.isActive == true) return
        termAttachJob = viewModelScope.launch { attachTerminal() }
    }

    fun onAppBackground() {
        detachTerminal(keepWanted = termWanted)
    }

    fun onAppForeground() {
        if (termWanted) ensureTerminal()
    }

    fun userDetachTerminal() {
        detachTerminal(keepWanted = false)
    }

    fun resizeTerminal(cols: Int, rows: Int) {
        if (cols == lastTermCols && rows == lastTermRows) return
        lastTermCols = cols
        lastTermRows = rows
        termScreen.resize(cols, rows)
        termClient?.resize(cols, rows)
        publishTerm()
    }

    fun sendTermBytes(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val asText = runCatching { String(bytes, Charsets.UTF_8) }.getOrNull()
        if (asText != null && OscFilter.isColorReport(asText)) return
        termClient?.sendKeys(bytes)
    }

    fun sendTermText(text: String, ctrl: Boolean) {
        if (text.isEmpty() || OscFilter.isColorReport(text)) return
        sendTermBytes(TermKeys.ime(text, ctrl))
    }

    fun consumeTermClipboard() {
        _state.update { it.copy(termClipboard = null) }
    }

    private fun detachTerminal(keepWanted: Boolean) {
        if (!keepWanted) termWanted = false
        val client = termClient
        termClient = null
        termWs = null
        termAttachJob?.cancel()
        termAttachJob = null
        client?.leave()
        _state.update { it.copy(termStatus = "closed") }
    }

    private suspend fun attachTerminal() {
        if (c.identity.generation() != identityGen) return
        _state.update { it.copy(termStatus = "connecting") }
        val st = _state.value
        val node = NodeRef(st.nodeName, st.nodeName, nodeDenUrl, true)
        val gw = c.transport.gateway(node)
        val command = rosterCommandFor(harnessId)
        val flags = spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
        val spawned = try {
            withContext(Dispatchers.IO) {
                gw.termSpawn(
                    session = st.sessionId,
                    cols = lastTermCols,
                    rows = lastTermRows,
                    command = command,
                    model = flags.model,
                    effort = flags.effort,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(termStatus = "closed", error = e.message ?: e.javaClass.simpleName) }
            return
        }
        if (c.identity.generation() != identityGen) return
        val cmd = renderAttachCommand(
            spawned.attach?.socket,
            spawned.attach?.session,
            spawned.attach?.host,
            spawned.attach?.sshUser,
        )
        _state.update { it.copy(attachCommand = cmd) }
        termScreen.reset(lastTermCols, lastTermRows)
        var ws: TermWs? = null
        termClient = TermPtyClient(
            object : TermSink {
                override fun sendText(text: String): Boolean = ws?.sendText(text) ?: false
                override fun sendBinary(bytes: ByteArray): Boolean = ws?.sendBinary(bytes) ?: false
                override fun close() { ws?.close() }
            },
        )
        termClient!!.replay.reset()
        ws = gw.watchTerm(
            spawned.id,
            onText = { text -> viewModelScope.launch { onTermText(text) } },
            onBinary = { bytes -> viewModelScope.launch { onTermBinary(bytes) } },
            onStatus = { s -> viewModelScope.launch { onTermStatus(s) } },
        )
        termWs = ws
        publishTerm()
    }

    private fun onTermText(text: String) {
        when (val frame = parseTermFrame(text)) {
            is TermFrame.Hello -> {
                termClient?.replay?.onHello(frame.frame.mux)
                termScreen.reset(lastTermCols, lastTermRows)
                if (frame.frame.state == "exited") {
                    termWs?.reconnectOnClose = false
                    _state.update { it.copy(termStatus = "exited") }
                } else {
                    _state.update { it.copy(termStatus = "attached") }
                }
                termClient?.resize(lastTermCols, lastTermRows)
                publishTerm()
            }
            is TermFrame.Exit -> {
                termWs?.reconnectOnClose = false
                _state.update { it.copy(termStatus = "exited") }
            }
            null -> Unit
        }
    }

    private fun onTermBinary(bytes: ByteArray) {
        val client = termClient ?: return
        if (!client.replay.acceptBinary()) return
        termScreen.feed(bytes)
        val clips = termScreen.drainOsc52()
        _state.update {
            it.copy(
                termRev = termScreen.generation,
                termClipboard = clips.lastOrNull() ?: it.termClipboard,
            )
        }
    }

    private fun onTermStatus(s: WsStatus) {
        when (s) {
            WsStatus.CONNECTING -> _state.update { it.copy(termStatus = "connecting") }
            WsStatus.OPEN -> {
                termClient?.replay?.reset()
                termScreen.reset(lastTermCols, lastTermRows)
                termClient?.resize(lastTermCols, lastTermRows)
                _state.update { it.copy(termStatus = "attached", termRev = termScreen.generation) }
            }
            WsStatus.CLOSED -> _state.update { st ->
                if (st.termStatus == "exited") st else st.copy(termStatus = "closed")
            }
        }
    }

    private fun publishTerm() {
        _state.update { it.copy(termRev = termScreen.generation) }
    }

    private suspend fun boot() {
        val prefs = c.settings.snapshot()
        val mode = parseSessionMode(prefs.sessionModes[_state.value.sessionId])
        _state.update { it.copy(mode = mode, termFontSp = prefs.terminalFontSp) }
        if (c.identity.generation() != identityGen) return
        try {
            val hg = c.harness(nodeDenUrl)
            val desc = withContext(Dispatchers.IO) { runCatching { hg.listHarnesses() }.getOrDefault(emptyList()) }
            val sheet = desc.find { it.harnessId == harnessId }?.capabilities?.toSheet()
                ?: desc.firstOrNull()?.capabilities?.toSheet()
            val model = defaultModel(sheet)
            val effort = defaultEffort(sheet, model)
            val item = ChatItem(
                key = _state.value.sessionId,
                kind = if (_state.value.draft) ChatItemKind.DRAFT else ChatItemKind.HARNESS,
                title = _state.value.title,
                sessionId = _state.value.sessionId.takeIf { !_state.value.draft },
                harnessId = harnessId,
            )
            val gate = harnessGate(item, desc)
            _state.update { it.copy(sheet = sheet, model = model, effort = effort, gate = gate) }
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
        }
        startRegistry()
        if (!_state.value.draft) startAttach(_state.value.sessionId)
    }

    private fun startRegistry() {
        registryWatch?.close()
        val hg = c.harness(nodeDenUrl)
        registryWatch = hg.watchRegistry(
            onEvent = { event -> viewModelScope.launch { onRegistry(event) } },
        )
    }

    private fun onRegistry(event: HarnessEvent) {
        if (c.identity.generation() != identityGen) return
        val native = _state.value.sessionId
        when (event) {
            is HarnessEvent.SessionCreated -> {
                val sid = event.summary.sessionId
                if (sid == native || sid.endsWith(":$native") || event.supersedes == native) {
                    adoptCanonical(sid)
                }
            }
            is HarnessEvent.SessionUpdated -> {
                val prev = event.previousSessionId
                if (prev == native || event.sessionId == native) adoptCanonical(event.sessionId)
            }
            else -> Unit
        }
    }

    private fun adoptCanonical(canonical: String) {
        val from = _state.value.sessionId
        if (canonical.isBlank() || canonical == from) {
            if (_state.value.draft) _state.update { it.copy(draft = false) }
            return
        }
        val wasDraft = _state.value.draft
        _state.update { it.copy(sessionId = canonical, draft = false) }
        viewModelScope.launch { c.settings.rekeySessionMode(from, canonical) }
        if (wasDraft || from != canonical) {
            startAttach(canonical)
        }
    }

    private fun startAttach(sessionId: String) {
        sessionWatch?.close()
        sessionWatch = null
        attach = null
        val hg = c.harness(nodeDenUrl)
        val enc = sessionKeyEnc(sessionId)
        val machineAttach = SessionAttach(
            machine = machine,
            fetchTranscript = {
                withContext(Dispatchers.IO) { hg.transcript(enc).turns }
            },
            onFatal = { msg -> _state.update { it.copy(error = msg, ws = WsStatus.CLOSED) } },
            closeWatch = { sessionWatch?.close() },
        )
        attach = machineAttach
        sessionWatch = hg.watchSession(
            enc,
            onEvent = { event ->
                viewModelScope.launch {
                    onSessionEvent(event)
                    machineAttach.onFrame(event)
                    publishMachine()
                    if (event is HarnessEvent.TurnComplete) {
                        runCatching { pump.onTurnComplete() }
                    }
                }
            },
            onStatus = { s ->
                viewModelScope.launch {
                    _state.update { it.copy(ws = s) }
                    if (s == WsStatus.OPEN) machineAttach.onWatchOpen()
                    publishMachine()
                }
            },
        )
    }

    private fun onSessionEvent(event: HarnessEvent) {
        when (event) {
            is HarnessEvent.ToolUse -> {
                liveTools += LiveTool(event.name, event.input)
                _state.update { it.copy(ask = cardFromLiveTools(liveTools)) }
            }
            is HarnessEvent.TurnComplete -> {
                // keep the ask card until answered
            }
            else -> Unit
        }
        val redirected = when (event) {
            is HarnessEvent.SessionCreated -> event.summary.redirectedTo ?: event.sessionId
            else -> null
        }
        if (redirected != null) adoptCanonical(redirected)
    }

    private suspend fun actuallySend(text: String) {
        if (c.identity.generation() != identityGen) return
        if (_state.value.draft) spawnAndAdopt()
        val id = _state.value.sessionId
        val hg = c.harness(nodeDenUrl)
        val accepted = withContext(Dispatchers.IO) {
            hg.sendTurn(sessionKeyEnc(id), UserTurn(text))
        }
        val canon = accepted.redirectedTo?.takeIf { it.isNotBlank() } ?: accepted.sessionId.takeIf { it.isNotBlank() }
        if (canon != null) adoptCanonical(canon)
    }

    private suspend fun spawnAndAdopt() {
        if (spawnInFlight) {
            withTimeoutOrNull(60_000) {
                while (_state.value.draft) delay(150)
            }
            return
        }
        spawnInFlight = true
        try {
            val st = _state.value
            val command = rosterCommandFor(harnessId)
            val flags = spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
            val node = NodeRef(st.nodeName, st.nodeName, nodeDenUrl, true)
            val gw = c.transport.gateway(node)
            withContext(Dispatchers.IO) {
                gw.termSpawn(
                    session = st.sessionId,
                    cols = 80,
                    rows = 24,
                    command = command,
                    model = flags.model,
                    effort = flags.effort,
                )
            }
            withTimeoutOrNull(60_000) {
                while (_state.value.draft) delay(150)
            }
            if (_state.value.draft) throw IllegalStateException("session was not adopted")
        } finally {
            spawnInFlight = false
        }
    }

    private fun publishMachine() {
        val thinking = machine.liveReasoning.ifBlank {
            splitHermesReasoning(machine.liveText).reasoning
        }
        _state.update {
            it.copy(
                turns = machine.transcript,
                liveText = machine.liveText,
                liveReasoning = thinking,
                inFlight = machine.inFlight,
            )
        }
    }

    fun effortOptions(): List<Pair<String, String>> {
        val st = _state.value
        return effortListFor(st.sheet, st.model).map { it.id to it.label }
    }
}
