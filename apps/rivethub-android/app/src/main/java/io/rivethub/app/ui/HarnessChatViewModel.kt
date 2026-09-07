package io.rivethub.app.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.AndroidLogger
import io.rivethub.app.data.OscFilter
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.UserTurn
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.WsSubscription
import io.rivethub.app.gateway.sessionKeyEnc
import io.rivethub.app.plane.serverInFlightIsStale
import io.rivethub.app.gateway.nativeIdOf
import io.rivethub.app.gateway.isTurnInFlight
import io.rivethub.app.plane.AskUserCard
import io.rivethub.app.plane.PromptSlot
import io.rivethub.app.plane.askCardError
import io.rivethub.app.plane.promptSlotAfter
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.CLOSED_GATE
import io.rivethub.app.plane.ChatSendAction
import io.rivethub.app.plane.EnqueueResult
import io.rivethub.app.plane.HarnessGate
import io.rivethub.app.plane.HarnessSheet
import io.rivethub.app.plane.IDLE_DEADLINE_MS
import io.rivethub.app.plane.LiveSource
import io.rivethub.app.plane.LiveTool
import io.rivethub.app.plane.OutboundItem
import io.rivethub.app.plane.OutboundPump
import io.rivethub.app.plane.PTY_READY_BOUND_MS
import io.rivethub.app.plane.PTY_READY_QUIET_MS
import io.rivethub.app.plane.PendingAttachment
import io.rivethub.app.plane.PendingApproval
import io.rivethub.app.plane.PtyReadyGate
import io.rivethub.app.plane.SessionAttach
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TranscriptMachine
import io.rivethub.app.plane.agentStatusLine
import io.rivethub.app.plane.registryEventMatchesOpen
import io.rivethub.app.plane.registryStamp
import io.rivethub.app.plane.adoptCanonicalIsNoOp
import io.rivethub.app.plane.canonicalFromSendTurn
import io.rivethub.app.plane.injectCompletedAfterSend
import io.rivethub.app.plane.promptAnswers
import io.rivethub.app.plane.resyncCompletesTurn
import io.rivethub.app.plane.resyncStillApplies
import io.rivethub.app.plane.shouldResyncFromRegistry
import io.rivethub.app.plane.anyUploading
import io.rivethub.app.plane.cardFromLiveTools
import io.rivethub.app.plane.chatItemForGate
import io.rivethub.app.plane.chatSendAction
import io.rivethub.app.plane.composerOnInput
import io.rivethub.app.plane.composerOnSendAttempt
import io.rivethub.app.plane.composeAskAnswer
import io.rivethub.app.plane.defaultEffort
import io.rivethub.app.plane.defaultModel
import io.rivethub.app.plane.effortListFor
import io.rivethub.app.plane.harnessGate
import io.rivethub.app.plane.nextInjectTry
import io.rivethub.app.plane.parseSessionMode
import io.rivethub.app.plane.persistSessionMode
import io.rivethub.app.plane.ptySpawnIsFresh
import io.rivethub.app.plane.readyUris
import io.rivethub.app.plane.rosterCommandFor
import io.rivethub.app.plane.sessionMatchesNative
import io.rivethub.app.plane.spawnAttempts
import io.rivethub.app.plane.spawnModelEffort
import io.rivethub.app.plane.TermAttachController
import io.rivethub.app.plane.TermScreenPort
import io.rivethub.app.plane.TermSocket
import io.rivethub.app.plane.TermSpawnPort
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.TermWatchFactory
import io.rivethub.app.plane.toSheet
import io.rivethub.app.plane.uploadBaseUrl
import io.rivethub.app.plane.uploadTooLarge
import io.rivethub.app.plane.withAttachmentText
import io.rivethub.app.ui.term.AnsiScreen
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable
import java.util.UUID

/** One re-send of a rev-gap sync if no snapshot followed (den throttles syncs to 1 per 2 s). */
const val SYNC_REARM_MS: Long = 3_000L

class HarnessChatViewModel(
    private val c: AppContainer,
    initialSessionKey: String,
    private val nodeDenUrl: String,
    private val harnessId: String?,
    initialTitle: String,
    initialDraft: Boolean,
    private val presetModel: String = "",
    private val presetEffort: String = "",
    private val openStream: (Uri) -> java.io.InputStream? = { null },
    private val agentId: String = "",
    private val onAdoptPointer: ((from: String, canonical: String) -> Unit)? = null,
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
        val turns: List<io.rivethub.app.gateway.HarnessTranscriptTurn> = emptyList(),
        val liveText: String = "",
        val liveReasoning: String = "",
        val liveTools: List<LiveTool> = emptyList(),
        val inFlight: Boolean = false,
        val ask: AskUserCard? = null,
        val promptId: String? = null,
        val answeringPrompt: Boolean = false,
        /** Card-local error (den `bad_request` text). Not the composer strip. */
        val askError: String? = null,
        val approval: PendingApproval? = null,
        val queued: List<OutboundItem> = emptyList(),
        val agentStatusText: String? = null,
        val composer: String = "",
        val attachments: List<PendingAttachment> = emptyList(),
        val sheet: HarnessSheet? = null,
        val gate: HarnessGate = CLOSED_GATE,
        val error: String? = null,
        val errorCode: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val moreOpen: Boolean = false,
        val termStatus: TermStatus = TermStatus.Closed,
        val termRev: Int = 0,
        val termFontSp: Int = 13,
        val termCtrl: Boolean = false,
        val attachCommand: String? = null,
        val termClipboard: String? = null,
        /** Terminal owner (den #681); null = nobody owns it. Drives the ownership overlay. */
        val termOwner: io.rivethub.app.gateway.TermOwner? = null,
        /** Context-bar wire contract (null until the den reports it → model-derived fallback). */
        val contextWindow: Int? = null,
        val compactAt: Int? = null,
        val contextSource: String? = null,
    )

    private val _state = MutableStateFlow(
        UiState(
            title = initialTitle,
            sessionId = initialSessionKey,
            draft = initialDraft,
            nodeName = hostOfUrl(nodeDenUrl),
            nodeDenUrl = nodeDenUrl,
            model = presetModel,
            effort = presetEffort,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val machine = TranscriptMachine(nowMs = { System.currentTimeMillis() })
    private var attach: SessionAttach? = null
    private var sessionWatch: WsSubscription? = null
    private var registryWatch: Closeable? = null
    private val identityGen = c.identity.generation()
    private var ptyId: String? = null
    private var lastSpawn: TermSpawnResponse? = null
    private var descriptors: List<HarnessDescriptor> = emptyList()
    private var frames = Channel<Frame>(Channel.UNLIMITED)
    private var frameJob: Job? = null

    private sealed interface Frame {
        data class Ev(val e: HarnessEvent) : Frame
        data class St(val s: WsStatus) : Frame
    }

    private val pump = OutboundPump(
        send = { text ->
            machine.appendOptimisticUser(text)
            machine.beginTurn()
            injectCompleted = false
            publishMachine()
            rearmIdleWatch()
            try {
                actuallySend(text)
                injectCompleted = true
                publishMachine()
            } catch (e: Throwable) {
                machine.revertOptimisticUser(text)
                // A 409 means a real turn IS streaming — dropping its bubble would
                // blank the reply the user is watching. Only a hard failure aborts.
                if (!isTurnInFlight(e)) machine.abortTurn()
                publishMachine()
                throw e
            }
        },
        attachmentsUploading = { anyUploading(_state.value.attachments) },
    )

    private var idleWatch: Job? = null
    /** Post-turn settle flush for hook-sourced stores (H1). */
    private var settleJob: Job? = null
    /** Rev-gap sync: den drops a sync within 2 s of the previous one, silently —
     *  re-send ONCE after a short wait unless a snapshot arrived (H3). */
    private var syncRearm: Job? = null
    private var awaitingSnapshot: Boolean = false

    private fun requestSync() {
        awaitingSnapshot = true
        val sent = sessionWatch?.send("""{"type":"sync"}""") == true
        syncRearm?.cancel()
        syncRearm = viewModelScope.launch {
            delay(SYNC_REARM_MS)
            if (awaitingSnapshot || !sent) sessionWatch?.send("""{"type":"sync"}""")
        }
    }
    private val spawnMu = Mutex()
    private var lastRegistryStatus: String? = null
    private var lastRegistryUpdatedAt: String? = null
    /** True after inject ok / sendTurn landed — a fetch before this cannot complete the turn. */
    private var injectCompleted: Boolean = false

    private val termScreen = AnsiScreen()
    private val termCtl = TermAttachController(
        scope = viewModelScope,
        spawn = TermSpawnPort { _, _, _, _, _, _ ->
            val slot = ensurePty()
            lastSpawn?.takeIf { it.id == slot.id } ?: TermSpawnResponse(id = slot.id)
        },
        watch = TermWatchFactory { ptyId, onText, onBinary, onStatus ->
            val ws = gateway().watchTerm(
                ptyId = ptyId,
                sessionId = _state.value.sessionId,
                onText = onText,
                onBinary = onBinary,
                onStatus = onStatus,
            )
            object : TermSocket {
                override var reconnectOnClose: Boolean
                    get() = ws.reconnectOnClose
                    set(v) { ws.reconnectOnClose = v }
                override fun sendText(text: String) = ws.sendText(text)
                override fun sendBinary(bytes: ByteArray) = ws.sendBinary(bytes)
                override fun close() = ws.close()
            }
        },
        screen = object : TermScreenPort {
            override fun reset(cols: Int, rows: Int) { termScreen.reset(cols, rows) }
            override fun resize(cols: Int, rows: Int) { termScreen.resize(cols, rows) }
            override fun feed(bytes: ByteArray) { termScreen.feed(bytes) }
            override fun drainOsc52() = termScreen.drainOsc52()
            override val generation get() = termScreen.generation
        },
        attachedGen = identityGen,
        currentGen = { c.identity.generation() },
        sessionId = { _state.value.sessionId },
        isDraft = { _state.value.draft },
        spawnAndAdopt = { spawnAndAdopt() },
        command = { rosterCommandFor(harnessId) },
        flags = {
            val st = _state.value
            spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
        },
        onPublish = { v ->
            _state.update {
                it.copy(
                    termStatus = v.status,
                    termRev = v.rev,
                    termCtrl = v.ctrl,
                    attachCommand = v.attachCommand,
                    termClipboard = v.clipboard,
                    termOwner = v.owner,
                    error = v.error ?: it.error,
                )
            }
        },
    )

    fun terminalScreen(): AnsiScreen = termScreen

    init {
        viewModelScope.launch { boot() }
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                _state.update { it.copy(termFontSp = p.terminalFontSp) }
            }
        }
    }

    fun setComposer(v: String) {
        val edit = composerOnInput(v)
        _state.update { it.copy(composer = edit.value, error = edit.error) }
    }
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
        if (anyUploading(st.attachments)) {
            _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_UPLOADING) }
            return
        }
        val text = withAttachmentText(st.composer.trim(), readyUris(st.attachments))
        if (text.isBlank()) return
        val keptComposer = st.composer
        _state.update { it.copy(composer = "", attachments = emptyList(), error = composerOnSendAttempt(), errorCode = null) }
        when (pump.tryEnqueue(text)) {
            is EnqueueResult.Uploading -> {
                _state.update { it.copy(composer = keptComposer, attachments = st.attachments, errorCode = ERR_UPLOADING) }
            }
            is EnqueueResult.Accepted -> {
                publishMachine()
                viewModelScope.launch {
                    runCatching { pump.pump() }.onSuccess {
                        if (pump.pendingOnServer) {
                            injectCompleted = injectCompletedAfterSend(ok = false, turnInFlight409 = true)
                        }
                        publishMachine()
                    }.onFailure { e ->
                        AndroidLogger.warn("RivetHub", "send failed: ${e.javaClass.simpleName}: ${e.message}", e)
                        publishMachine()
                        _state.update {
                            it.copy(
                                error = e.message ?: e.javaClass.simpleName,
                                composer = if (it.composer.isBlank()) keptComposer else it.composer,
                            )
                        }
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
        val st = _state.value
        // In-flight guard (web keeps the same ref): every option row is a submit
        // surface now, and a second POST for the same promptId would type the
        // old answer's digit into the NEXT screen-read question.
        if (st.answeringPrompt) return
        val card = st.ask ?: return
        val promptId = st.promptId
        if (promptId != null) {
            val answers = promptAnswers(card.questions, picked, free)
            if (answers.all { it.labels.isEmpty() && it.other.isNullOrBlank() }) return
            _state.update { it.copy(answeringPrompt = true) }
            viewModelScope.launch(Dispatchers.IO) {
                runCatching {
                    c.harness(nodeDenUrl).answerPrompt(sessionKeyEnc(_state.value.sessionId), promptId, answers)
                }.onFailure { e ->
                    val cardError = askCardError(e)
                    _state.update {
                        if (cardError != null) {
                            it.copy(answeringPrompt = false, askError = cardError)
                        } else {
                            it.copy(answeringPrompt = false, error = e.message ?: e.javaClass.simpleName)
                        }
                    }
                }.onSuccess {
                    _state.update { it.copy(answeringPrompt = false, askError = null) }
                }
            }
            return
        }
        val text = composeAskAnswer(card.questions, picked, free)
        if (text.isBlank()) return
        _state.update { it.copy(ask = null, composer = text) }
        send()
    }

    fun dismissAsk() {
        _state.update { it.copy(ask = null, promptId = null, answeringPrompt = false, askError = null) }
    }

    fun decideApproval(reqId: String, decision: String) {
        val st = _state.value
        if (st.draft) return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching {
                c.harness(nodeDenUrl).resolveApproval(sessionKeyEnc(st.sessionId), reqId, decision)
            }.onFailure { e ->
                _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
            }
        }
    }

    fun cancelQueued(id: String) {
        viewModelScope.launch {
            val item = pump.cancel(id) ?: return@launch
            _state.update {
                val rest = if (it.composer.isBlank()) "" else "\n" + it.composer
                it.copy(composer = item.text + rest, queued = pump.queued)
            }
        }
    }

    fun injectQueued(id: String) {
        val st = _state.value
        val item = pump.queued.firstOrNull { it.id == id } ?: return
        viewModelScope.launch {
            if (st.inFlight && st.gate.canInterrupt && !st.draft) {
                runCatching {
                    withContext(Dispatchers.IO) { c.harness(nodeDenUrl).interrupt(sessionKeyEnc(st.sessionId)) }
                }
            }
            try {
                pump.pump(forceId = id)
            } catch (e: Throwable) {
                if (!isTurnInFlight(e)) {
                    // The pump dropped the item on a hard failure: say so and hand
                    // the text back instead of letting it vanish from the strip.
                    AndroidLogger.warn("RivetHub", "inject failed: ${e.javaClass.simpleName}: ${e.message}", e)
                    _state.update {
                        val rest = if (it.composer.isBlank()) "" else "\n" + it.composer
                        it.copy(error = e.message ?: e.javaClass.simpleName, composer = item.text + rest)
                    }
                }
            }
            publishMachine()
        }
    }

    fun stageUri(uri: Uri, name: String, mime: String?, size: Long) {
        val id = UUID.randomUUID().toString()
        if (uploadTooLarge(size)) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED),
                    errorCode = ERR_TOO_LARGE,
                )
            }
            return
        }
        _state.update {
            it.copy(attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.UPLOADING), errorCode = null)
        }
        viewModelScope.launch {
            val entry = c.settings.snapshot().entryUrl
            val base = uploadBaseUrl(nodeDenUrl, entry)
            try {
                val staged = withContext(Dispatchers.IO) {
                    c.harness(base).stageUpload(if (size >= 0) size else -1L, name, mime) {
                        openStream(uri) ?: throw java.io.IOException("could not open attachment")
                    }
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

    fun stageBytes(bytes: ByteArray, name: String, mime: String?) {
        val id = UUID.randomUUID().toString()
        if (uploadTooLarge(bytes.size.toLong())) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED),
                    errorCode = ERR_TOO_LARGE,
                )
            }
            return
        }
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
        idleWatch?.cancel()
        frameJob?.cancel()
        frames.close()
        sessionWatch?.close()
        registryWatch?.close()
        attach?.detach()
        termCtl.close()
        super.onCleared()
    }

    fun ensureTerminal() {
        AndroidLogger.debug("RivetHub", "term ensure: draft=${_state.value.draft} session=${_state.value.sessionId} pty=$ptyId", null)
        termCtl.ensure()
    }

    fun onAppBackground() = termCtl.onBackground()

    fun onAppForeground() = termCtl.onForeground()

    fun userDetachTerminal() = termCtl.userDetach()

    fun resizeTerminal(cols: Int, rows: Int) = termCtl.resize(cols, rows)

    /** "Use terminal here" — claim terminal ownership from the other device. */
    fun claimTerminal() = termCtl.claimTerminal()

    fun sendTermBytes(bytes: ByteArray) = termCtl.sendBytes(bytes)

    fun sendTermText(text: String) {
        if (text.isEmpty() || OscFilter.isColorReport(text)) return
        termCtl.sendText(text)
    }

    fun toggleTermCtrl() = termCtl.toggleCtrl()

    fun lockTermCtrl() = termCtl.lockCtrl()

    fun consumeTermClipboard() = termCtl.consumeClipboard()

    private suspend fun boot() {
        val prefs = c.settings.snapshot()
        val mode = parseSessionMode(prefs.sessionModes[_state.value.sessionId])
        _state.update { it.copy(mode = mode, termFontSp = prefs.terminalFontSp) }
        if (c.identity.generation() != identityGen) return
        try {
            val hg = c.harness(nodeDenUrl)
            val desc = withContext(Dispatchers.IO) { runCatching { hg.listHarnesses() }.getOrDefault(emptyList()) }
            descriptors = desc
            val sheet = desc.find { it.harnessId == harnessId }?.capabilities?.toSheet()
            val model = presetModel.ifBlank { defaultModel(sheet) }
            val effort = presetEffort.ifBlank { defaultEffort(sheet, model) }
            _state.update { it.copy(sheet = sheet, model = model, effort = effort) }
            recomputeGate()
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
        }
        startRegistry()
        if (!_state.value.draft) startAttach(_state.value.sessionId)
    }

    private fun recomputeGate() {
        val st = _state.value
        val item = chatItemForGate(st.sessionId, st.draft, harnessId, st.title)
        _state.update { it.copy(gate = harnessGate(item, descriptors)) }
    }

    private fun startRegistry() {
        registryWatch?.close()
        val hg = c.harness(nodeDenUrl)
        registryWatch = hg.watchRegistry(
            onEvent = { event -> viewModelScope.launch { onRegistry(event) } },
        )
    }

    private fun onRegistry(event: HarnessEvent) {
        AndroidLogger.debug("RivetHub", "registry event: ${event.javaClass.simpleName} ${(event as? io.rivethub.app.gateway.HarnessEvent.SessionCreated)?.sessionId ?: ""}", null)
        if (c.identity.generation() != identityGen) return
        val native = _state.value.sessionId
        when (event) {
            is HarnessEvent.SessionCreated -> {
                val sid = event.summary.sessionId
                if (
                    sessionMatchesNative(sid, native) ||
                    sessionMatchesNative(event.supersedes, native) ||
                    sessionMatchesNative(event.summary.redirectedTo, native)
                ) {
                    adoptCanonical(sid)
                    maybeRegistryResync(event)
                }
            }
            is HarnessEvent.SessionUpdated -> {
                if (
                    sessionMatchesNative(event.previousSessionId, native) ||
                    sessionMatchesNative(event.sessionId, native)
                ) {
                    adoptCanonical(event.sessionId)
                    maybeRegistryResync(event)
                }
            }
            else -> Unit
        }
    }

    private fun maybeRegistryResync(event: HarnessEvent) {
        val stamp = registryStamp(event) ?: return
        val open = _state.value.sessionId
        val should = shouldResyncFromRegistry(
            inFlight = machine.inFlight,
            matchesOpenSession = registryEventMatchesOpen(event, open),
            status = stamp.status,
            updatedAt = stamp.updatedAt,
            lastStatus = lastRegistryStatus,
            lastUpdatedAt = lastRegistryUpdatedAt,
        )
        lastRegistryStatus = stamp.status ?: lastRegistryStatus
        lastRegistryUpdatedAt = stamp.updatedAt ?: lastRegistryUpdatedAt
        if (!should) return
        AndroidLogger.debug("RivetHub", "registry resync: status=${stamp.status} session=$open", null)
        viewModelScope.launch { resyncTranscript() }
    }

    private fun adoptCanonical(canonical: String) {
        AndroidLogger.debug("RivetHub", "adopt: canonical=$canonical draft=${_state.value.draft} prev=${_state.value.sessionId}", null)
        val from = _state.value.sessionId
        if (canonical.isBlank()) return
        val wasDraft = _state.value.draft
        // redirectedTo echo of the id we already hold: no re-attach, no poll reset.
        if (adoptCanonicalIsNoOp(canonical, from, wasDraft)) return
        if (canonical == from) {
            if (wasDraft) {
                _state.update { it.copy(draft = false) }
                recomputeGate()
                machine.rearmIdle()
                startAttach(canonical)
                rearmIdleWatch()
            }
            return
        }
        _state.update { it.copy(sessionId = canonical, draft = false) }
        recomputeGate()
        machine.rearmIdle()
        if (agentId.isNotBlank()) onAdoptPointer?.invoke(from, canonical)
        viewModelScope.launch { c.settings.rekeySessionMode(from, canonical) }
        if (wasDraft || from != canonical) {
            startAttach(canonical)
            rearmIdleWatch()
        }
    }

    private fun startAttach(sessionId: String) {
        attach?.detach()
        settleJob?.cancel()
        syncRearm?.cancel()
        sessionWatch?.close()
        sessionWatch = null
        frameJob?.cancel()
        frames.close()
        frames = Channel(Channel.UNLIMITED)
        val hg = c.harness(nodeDenUrl)
        val enc = sessionKeyEnc(sessionId)
        val myWatch = arrayOfNulls<WsSubscription>(1)
        val machineAttach = SessionAttach(
            machine = machine,
            fetchTranscript = {
                val resp = withContext(Dispatchers.IO) { hg.transcript(enc) }
                AndroidLogger.debug("RivetHub", "transcript fetched: ${resp.turns.size} turns for $sessionId", null)
                _state.update {
                    it.copy(
                        contextWindow = resp.contextWindow,
                        compactAt = resp.compactAt,
                        contextSource = resp.contextSource,
                    )
                }
                resp.turns
            },
            onFatal = { msg ->
                AndroidLogger.warn("RivetHub", "attach fatal: $msg", null)
                _state.update { it.copy(error = msg, ws = WsStatus.CLOSED) }
            },
            closeWatch = { myWatch[0]?.close() },
        )
        attach = machineAttach
        val mailbox = frames
        frameJob = viewModelScope.launch {
            for (f in mailbox) {
                if (c.identity.generation() != identityGen) {
                    termCtl.drop()
                    return@launch
                }
                AndroidLogger.debug("RivetHub", "session frame: ${f.javaClass.simpleName}", null)
                when (f) {
                    is Frame.Ev -> {
                        when (val e = f.e) {
                            is HarnessEvent.Transcript -> {
                                val ok = machine.applyTranscriptFrame(e)
                                if (e.from == 0) {
                                    awaitingSnapshot = false
                                    syncRearm?.cancel()
                                }
                                if (!ok) requestSync()
                                if (e.from == 0) {
                                    _state.update {
                                        it.copy(
                                            contextWindow = e.contextWindow ?: it.contextWindow,
                                            compactAt = e.compactAt ?: it.compactAt,
                                            contextSource = e.contextSource ?: it.contextSource,
                                        )
                                    }
                                }
                            }
                            is HarnessEvent.Status -> {
                                machine.onStatus(e)
                                if (e.status == "idle") runCatching { pump.onIdle() }
                            }
                            is HarnessEvent.Prompt -> {
                                machine.onPrompt(e)
                                val cur = _state.value.let { s ->
                                    val id = s.promptId
                                    val card = s.ask
                                    if (id != null && card != null) PromptSlot(id, card) else null
                                }
                                val next = promptSlotAfter(cur, e)
                                if (next !== cur) {
                                    _state.update {
                                        it.copy(
                                            ask = next?.card,
                                            promptId = next?.promptId,
                                            answeringPrompt = false,
                                            askError = null,
                                        )
                                    }
                                }
                            }
                            is HarnessEvent.ApprovalRequest -> {
                                _state.update {
                                    it.copy(approval = PendingApproval(e.requestId, e.name, e.reason, e.input))
                                }
                            }
                            is HarnessEvent.ApprovalResolved -> {
                                if (_state.value.approval?.requestId == e.requestId) {
                                    _state.update { it.copy(approval = null) }
                                }
                            }
                            is HarnessEvent.TurnComplete -> {
                                machineAttach.onFrame(e)
                                runCatching { pump.onTurnComplete() }
                                // Hook-sourced stores: the post-turn hard resync after the
                                // settle window (one-shot, re-armed by the frame).
                                if (machine.liveSource == LiveSource.HOOKS) {
                                    settleJob?.cancel()
                                    settleJob = viewModelScope.launch {
                                        delay(machineAttach.settleMs)
                                        machineAttach.flushCommittedResync()
                                        publishMachine()
                                    }
                                }
                            }
                            else -> {
                                machineAttach.onFrame(e)
                                onSessionEvent(e)
                            }
                        }
                        publishMachine()
                        rearmIdleWatch()
                    }
                    is Frame.St -> {
                        if (f.s == WsStatus.OPEN) {
                            _state.update {
                                it.copy(
                                    ws = f.s,
                                    ask = null,
                                    promptId = null,
                                    answeringPrompt = false,
                                    approval = null,
                                    askError = null,
                                )
                            }
                            machineAttach.onWatchOpen()
                        } else {
                            _state.update { it.copy(ws = f.s) }
                        }
                        publishMachine()
                    }
                }
            }
        }
        sessionWatch = hg.watchSession(
            enc,
            onEvent = { event -> mailbox.trySend(Frame.Ev(event)) },
            onStatus = { s ->
                AndroidLogger.debug("RivetHub", "session ws status: $s", null)
                mailbox.trySend(Frame.St(s))
            },
        )
        myWatch[0] = sessionWatch
    }

    private fun onSessionEvent(event: HarnessEvent) {
        when (event) {
            is HarnessEvent.ToolUse -> {
                if (machine.liveSource == LiveSource.HOOKS && _state.value.promptId == null) {
                    _state.update { it.copy(ask = cardFromLiveTools(machine.liveTools)) }
                }
            }
            else -> Unit
        }
        val redirected = when (event) {
            is HarnessEvent.SessionCreated -> event.summary.redirectedTo ?: event.sessionId
            else -> null
        }
        if (redirected != null && (
            !_state.value.draft || sessionMatchesNative(redirected, _state.value.sessionId)
        )) {
            adoptCanonical(redirected)
        }
    }

    private suspend fun actuallySend(text: String) {
        if (c.identity.generation() != identityGen) {
            AndroidLogger.debug("RivetHub", "send dropped: identity generation changed", null)
            return
        }
        AndroidLogger.debug("RivetHub", "send: draft=${_state.value.draft} session=${_state.value.sessionId} node=$nodeDenUrl", null)
        val st = _state.value
        when (val action = chatSendAction(st.draft, st.sessionId, text)) {
            is ChatSendAction.Inject -> injectDraft(action)
            is ChatSendAction.SendTurn -> sendAdopted(action)
        }
    }

    private suspend fun sendAdopted(action: ChatSendAction.SendTurn) {
        val hg = c.harness(nodeDenUrl)
        val accepted = try {
            withContext(Dispatchers.IO) {
                hg.sendTurn(sessionKeyEnc(action.sessionId), UserTurn(action.text))
            }
        } catch (e: Exception) {
            // The den holds a turn "in flight" for up to 5 min when its hook events are
            // missing. If our previous turn is already answered on disk, that hold is stale:
            // deliver this turn through the PTY like the draft path does (desktop legacy path).
            // Evaluate over the COMMITTED transcript: a foreign client's user turn lives there,
            // our optimistic bubble never does — so a genuine in-flight turn is never misread as stale.
            if (!isTurnInFlight(e) || !serverInFlightIsStale(machine.committedTurns)) throw e
            val native = nativeIdOf(action.sessionId) ?: throw e
            AndroidLogger.warn("RivetHub", "409 with a finished previous turn: injecting via PTY session=$native", null)
            val pty = ensurePty(sessionOverride = native)
            if (pty.fresh) waitUntilPtyReady(pty.id)
            withContext(Dispatchers.IO) { gateway().termInject(session = native, text = action.text) }
            injectCompleted = true
            return
        }
        val canon = canonicalFromSendTurn(accepted.redirectedTo, accepted.sessionId, action.sessionId)
        if (canon != null) adoptCanonical(canon)
        injectCompleted = injectCompletedAfterSend(ok = true, turnInFlight409 = false)
    }

    private suspend fun injectDraft(action: ChatSendAction.Inject) {
        val gw = gateway()
        var retried = false
        while (true) {
            try {
                val pty = ensurePty()
                if (pty.fresh) waitUntilPtyReady(pty.id)
                withContext(Dispatchers.IO) { gw.termInject(session = action.sessionId, text = action.text) }
                AndroidLogger.debug("RivetHub", "inject ok: session=${action.sessionId} pty=$ptyId", null)
                injectCompleted = true
                return
            } catch (e: Exception) {
                if (nextInjectTry(failed = true, alreadyRetried = retried) == null) throw e
                retried = true
                ptyId = null
            }
        }
    }

    private data class PtySlot(val id: String, val fresh: Boolean)

    private suspend fun ensurePty(sessionOverride: String? = null): PtySlot = spawnMu.withLock {
        ptyId?.let { return@withLock PtySlot(it, fresh = false) }
        val st = _state.value
        val command = rosterCommandFor(harnessId)
        val flags = spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
        val gw = gateway()
        val attempts = spawnAttempts(sessionOverride ?: st.sessionId, command, flags.model, flags.effort)
        var last: Exception? = null
        for (attempt in attempts) {
            try {
                val spawned = withContext(Dispatchers.IO) {
                    gw.termSpawn(
                        session = attempt.session,
                        cols = 80,
                        rows = 24,
                        command = attempt.command,
                        model = attempt.model,
                        effort = attempt.effort,
                    )
                }
                val fresh = ptySpawnIsFresh(alreadyHeld = false, reattached = spawned.reattached)
                ptyId = spawned.id
                lastSpawn = spawned
                AndroidLogger.debug("RivetHub", "spawned pty=${spawned.id} for session=${attempt.session} cmd=${attempt.command}", null)
                return@withLock PtySlot(spawned.id, fresh)
            } catch (e: Exception) {
                AndroidLogger.warn("RivetHub", "spawn attempt failed session=${attempt.session} cmd=${attempt.command}: ${e.message}", e)
                last = e
            }
        }
        throw last ?: IllegalStateException("termSpawn failed")
    }

    private suspend fun waitUntilPtyReady(ptyId: String) {
        val gate = PtyReadyGate({ System.currentTimeMillis() })
        val ready = CompletableDeferred<Unit>()
        var quietJob: Job? = null
        fun armQuiet() {
            quietJob?.cancel()
            quietJob = viewModelScope.launch {
                delay(PTY_READY_QUIET_MS)
                if (gate.isReady() && !ready.isCompleted) ready.complete(Unit)
            }
        }
        val watch = gateway().watchTerm(
            ptyId = ptyId,
            sessionId = _state.value.sessionId,
            onText = {
                if (it.isNotEmpty()) {
                    gate.onOutput()
                    armQuiet()
                }
            },
            onBinary = {
                if (it.isNotEmpty()) {
                    gate.onOutput()
                    armQuiet()
                }
            },
        )
        try {
            withTimeout(PTY_READY_BOUND_MS + 250) { ready.await() }
        } catch (_: TimeoutCancellationException) {
            // bounded — inject anyway
        } finally {
            quietJob?.cancel()
            watch.close()
        }
    }

    private fun gateway() = c.transport.gateway(
        NodeRef(_state.value.nodeName, _state.value.nodeName, nodeDenUrl, true),
    )

    /**
     * Draft Terminal tab: share [ensurePty] (the chat spawn path), then wait
     * for the existing registry watch to adopt. Does not inject and does not
     * start the first-send adopt poll (that path's bare submit is inject-only).
     * Un-adopted drafts do not open a watch — [TermAttachController] gates that.
     */
    private suspend fun spawnAndAdopt() {
        AndroidLogger.debug("RivetHub", "term spawnAndAdopt: draft=${_state.value.draft} session=${_state.value.sessionId}", null)
        ensurePty()
        withTimeoutOrNull(60_000) {
            state.first { !it.draft }
        }
    }

    private fun rearmIdleWatch() {
        idleWatch?.cancel()
        if (!machine.inFlight) return
        val last = machine.lastFrameTs ?: machine.turnStartTs ?: return
        val remaining = IDLE_DEADLINE_MS - (System.currentTimeMillis() - last)
        idleWatch = viewModelScope.launch {
            delay(remaining.coerceAtLeast(0L))
            if (c.identity.generation() != identityGen) {
                termCtl.drop()
                return@launch
            }
            if (machine.idleTimedOut()) {
                machine.onFrame(HarnessEvent.Error(_state.value.sessionId, "idle_timeout", "turn timed out"))
                runCatching { pump.onTurnComplete() }
                publishMachine()
            }
        }
    }

    private suspend fun resyncTranscript(reason: String = "resync") {
        if (c.identity.generation() != identityGen) return
        if (machine.liveSource == LiveSource.TRANSCRIPT) return
        val st = _state.value
        if (st.draft) return
        val sid = st.sessionId
        val current = attach
        val turns = if (current != null) {
            current.fetchTranscriptNow() ?: return
        } else {
            val enc = sessionKeyEnc(sid)
            val resp = withContext(Dispatchers.IO) {
                runCatching { c.harness(nodeDenUrl).transcript(enc) }.getOrNull()
            } ?: return
            _state.update {
                it.copy(
                    contextWindow = resp.contextWindow,
                    compactAt = resp.compactAt,
                    contextSource = resp.contextSource,
                )
            }
            resp.turns
        }
        if (!resyncStillApplies(sid, _state.value.sessionId, attach === current)) return
        val complete = resyncCompletesTurn(
            fetched = turns,
            pendingUserText = machine.pendingUserText,
            committedPrefix = machine.committedAtTurnStart,
            injectCompleted = injectCompleted,
        )
        val label = if (reason == "poll") "transcript poll" else "transcript resync"
        AndroidLogger.debug("RivetHub", "$label: ${turns.size} turns complete=$complete", null)
        current?.bumpGeneration()
        if (complete) {
            machine.onTurnComplete(turns)
            runCatching { pump.acknowledgePending() }
            runCatching { pump.onTurnComplete() }
        } else {
            machine.applyFetched(turns, complete = false)
        }
        publishMachine()
    }

    private fun publishMachine() {
        val thinking = machine.liveReasoning.ifBlank {
            splitHermesReasoning(machine.liveText).reasoning
        }
        val st = machine.agentStatus
        _state.update {
            it.copy(
                turns = machine.transcript,
                liveText = machine.liveText,
                liveReasoning = thinking,
                liveTools = machine.liveTools,
                inFlight = machine.inFlight,
                queued = pump.queued.filter { q -> q.status == OutboundItem.Status.QUEUED },
                agentStatusText = agentStatusLine(st?.status, st?.phase, st?.toolName),
            )
        }
    }

    fun effortOptions(): List<Pair<String, String>> {
        val st = _state.value
        return effortListFor(st.sheet, st.model).map { it.id to it.label }
    }

    companion object {
        const val ERR_UPLOADING = "uploading"
        const val ERR_TOO_LARGE = "too_large"
    }
}
