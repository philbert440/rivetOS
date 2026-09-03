package io.rivethub.app.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.UserTurn
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.sessionKeyEnc
import io.rivethub.app.plane.AskUserCard
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.CLOSED_GATE
import io.rivethub.app.plane.ChatSendAction
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
import io.rivethub.app.plane.chatItemForGate
import io.rivethub.app.plane.chatSendAction
import io.rivethub.app.plane.composeAskAnswer
import io.rivethub.app.plane.defaultEffort
import io.rivethub.app.plane.defaultModel
import io.rivethub.app.plane.effortListFor
import io.rivethub.app.plane.harnessGate
import io.rivethub.app.plane.nextInjectTry
import io.rivethub.app.plane.parseSessionMode
import io.rivethub.app.plane.persistSessionMode
import io.rivethub.app.plane.readyUris
import io.rivethub.app.plane.rosterCommandFor
import io.rivethub.app.plane.spawnAttempts
import io.rivethub.app.plane.spawnModelEffort
import io.rivethub.app.plane.toSheet
import io.rivethub.app.plane.uploadBaseUrl
import io.rivethub.app.plane.uploadTooLarge
import io.rivethub.app.plane.withAttachmentText
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.util.UUID

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
        val inFlight: Boolean = false,
        val ask: AskUserCard? = null,
        val composer: String = "",
        val attachments: List<PendingAttachment> = emptyList(),
        val sheet: HarnessSheet? = null,
        val gate: HarnessGate = CLOSED_GATE,
        val error: String? = null,
        val errorCode: String? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val moreOpen: Boolean = false,
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
    private val liveTools = ArrayList<LiveTool>()
    private var attach: SessionAttach? = null
    private var sessionWatch: Closeable? = null
    private var registryWatch: Closeable? = null
    private val identityGen = c.identity.generation()
    private var spawnInFlight = false
    private var ptyId: String? = null
    private var descriptors: List<HarnessDescriptor> = emptyList()
    private var frames = Channel<Frame>(Channel.UNLIMITED)
    private var frameJob: Job? = null

    private sealed interface Frame {
        data class Ev(val e: HarnessEvent) : Frame
        data class St(val s: WsStatus) : Frame
        data object Resync : Frame
    }

    private val pump = OutboundPump(
        send = { text -> actuallySend(text) },
        attachmentsUploading = { anyUploading(_state.value.attachments) },
    )

    private var tick: Job? = null

    init {
        viewModelScope.launch { boot() }
        tick = viewModelScope.launch {
            while (true) {
                delay(15_000)
                if (c.identity.generation() != identityGen) return@launch
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
        if (anyUploading(st.attachments)) {
            _state.update { it.copy(errorCode = ERR_UPLOADING) }
            return
        }
        val text = withAttachmentText(st.composer.trim(), readyUris(st.attachments))
        if (text.isBlank()) return
        val keptComposer = st.composer
        _state.update { it.copy(composer = "", attachments = emptyList(), error = null, errorCode = null) }
        when (pump.tryEnqueue(text)) {
            is EnqueueResult.Uploading -> {
                _state.update { it.copy(composer = keptComposer, attachments = st.attachments, errorCode = ERR_UPLOADING) }
            }
            is EnqueueResult.Accepted -> {
                machine.beginTurn()
                publishMachine()
                viewModelScope.launch {
                    runCatching { pump.pump() }.onFailure { e ->
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
        tick?.cancel()
        frameJob?.cancel()
        frames.close()
        sessionWatch?.close()
        registryWatch?.close()
        attach?.detach()
        super.onCleared()
    }

    private suspend fun boot() {
        val prefs = c.settings.snapshot()
        val mode = parseSessionMode(prefs.sessionModes[_state.value.sessionId])
        _state.update { it.copy(mode = mode) }
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
            if (_state.value.draft) {
                _state.update { it.copy(draft = false) }
                recomputeGate()
            }
            return
        }
        val wasDraft = _state.value.draft
        _state.update { it.copy(sessionId = canonical, draft = false) }
        recomputeGate()
        viewModelScope.launch { c.settings.rekeySessionMode(from, canonical) }
        if (wasDraft || from != canonical) {
            startAttach(canonical)
        }
    }

    private fun startAttach(sessionId: String) {
        attach?.detach()
        sessionWatch?.close()
        sessionWatch = null
        frameJob?.cancel()
        frames.close()
        frames = Channel(Channel.UNLIMITED)
        val hg = c.harness(nodeDenUrl)
        val enc = sessionKeyEnc(sessionId)
        val myWatch = arrayOfNulls<Closeable>(1)
        val machineAttach = SessionAttach(
            machine = machine,
            fetchTranscript = {
                withContext(Dispatchers.IO) { hg.transcript(enc).turns }
            },
            onFatal = { msg -> _state.update { it.copy(error = msg, ws = WsStatus.CLOSED) } },
            closeWatch = { myWatch[0]?.close() },
        )
        attach = machineAttach
        val mailbox = frames
        frameJob = viewModelScope.launch {
            for (f in mailbox) {
                when (f) {
                    is Frame.Ev -> {
                        onSessionEvent(f.e)
                        machineAttach.onFrame(f.e)
                        publishMachine()
                        if (f.e is HarnessEvent.TurnComplete) {
                            runCatching { pump.onTurnComplete() }
                            launch {
                                delay(machineAttach.settleMs)
                                mailbox.trySend(Frame.Resync)
                            }
                        }
                    }
                    is Frame.St -> {
                        _state.update { it.copy(ws = f.s) }
                        if (f.s == WsStatus.OPEN) machineAttach.onWatchOpen()
                        publishMachine()
                    }
                    Frame.Resync -> {
                        machineAttach.flushCommittedResync()
                        publishMachine()
                    }
                }
            }
        }
        sessionWatch = hg.watchSession(
            enc,
            onEvent = { event -> mailbox.trySend(Frame.Ev(event)) },
            onStatus = { s -> mailbox.trySend(Frame.St(s)) },
        )
        myWatch[0] = sessionWatch
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
        val st = _state.value
        when (val action = chatSendAction(st.draft, st.sessionId, text)) {
            is ChatSendAction.Inject -> injectDraft(action)
            is ChatSendAction.SendTurn -> sendAdopted(action)
        }
    }

    private suspend fun sendAdopted(action: ChatSendAction.SendTurn) {
        val hg = c.harness(nodeDenUrl)
        val accepted = withContext(Dispatchers.IO) {
            hg.sendTurn(sessionKeyEnc(action.sessionId), UserTurn(action.text))
        }
        val canon = accepted.redirectedTo?.takeIf { it.isNotBlank() } ?: accepted.sessionId.takeIf { it.isNotBlank() }
        if (canon != null) adoptCanonical(canon)
    }

    private suspend fun injectDraft(action: ChatSendAction.Inject) {
        ensurePty()
        val gw = gateway()
        try {
            withContext(Dispatchers.IO) { gw.termInject(session = action.sessionId, text = action.text) }
        } catch (e: Exception) {
            if (nextInjectTry(failed = true, alreadyRetried = false) == null) throw e
            ptyId = null
            ensurePty()
            withContext(Dispatchers.IO) { gw.termInject(session = action.sessionId, text = action.text) }
        }
    }

    private suspend fun ensurePty(): String {
        ptyId?.let { return it }
        if (spawnInFlight) {
            while (spawnInFlight) delay(50)
            ptyId?.let { return it }
        }
        spawnInFlight = true
        try {
            ptyId?.let { return it }
            val st = _state.value
            val command = rosterCommandFor(harnessId)
            val flags = spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
            val gw = gateway()
            val attempts = spawnAttempts(st.sessionId, command, flags.model, flags.effort)
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
                    ptyId = spawned.id
                    return spawned.id
                } catch (e: Exception) {
                    last = e
                }
            }
            throw last ?: IllegalStateException("termSpawn failed")
        } finally {
            spawnInFlight = false
        }
    }

    private fun gateway() = c.transport.gateway(
        NodeRef(_state.value.nodeName, _state.value.nodeName, nodeDenUrl, true),
    )

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

    companion object {
        const val ERR_UPLOADING = "uploading"
        const val ERR_TOO_LARGE = "too_large"
    }
}
