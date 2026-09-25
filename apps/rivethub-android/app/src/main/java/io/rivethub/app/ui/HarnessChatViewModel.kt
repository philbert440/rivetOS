package io.rivethub.app.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.AndroidLogger
import io.rivethub.app.data.OscFilter
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.HARNESS_IDS
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.WsSubscription
import io.rivethub.app.gateway.sessionKeyEnc
import io.rivethub.app.gateway.readCapped
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
import io.rivethub.app.plane.EditState
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
import io.rivethub.app.plane.PlusItem
import io.rivethub.app.plane.plusPanelItems
import io.rivethub.app.plane.PendingApproval
import io.rivethub.app.plane.StagedTurnAttachment
import io.rivethub.app.plane.PtyReadyGate
import io.rivethub.app.plane.SessionAttach
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TranscriptMachine
import io.rivethub.app.plane.ChatError
import io.rivethub.app.plane.ERR_CODE_FAILED_ATTACHMENT
import io.rivethub.app.plane.ERR_CODE_IMAGE_ONLY
import io.rivethub.app.plane.ERR_CODE_IMAGE_UNSUPPORTED
import io.rivethub.app.plane.ERR_CODE_TOO_LARGE
import io.rivethub.app.plane.ERR_CODE_UPLOADING
import io.rivethub.app.plane.ReasoningLedger
import io.rivethub.app.plane.ReasoningSpan
import io.rivethub.app.plane.RepeatErrorGate
import io.rivethub.app.plane.admit
import io.rivethub.app.plane.advance
import io.rivethub.app.plane.fileSpan
import io.rivethub.app.plane.nonReasoning
import io.rivethub.app.plane.pushError
import io.rivethub.app.plane.reasoningDelta
import io.rivethub.app.plane.settle
import io.rivethub.app.plane.startTurn
import io.rivethub.app.plane.clearErrors as clearChatErrors
import io.rivethub.app.plane.dismissError as dismissChatError
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
import io.rivethub.app.plane.anyFailed
import io.rivethub.app.plane.anyUploading
import io.rivethub.app.plane.beginEdit as beginEditState
import io.rivethub.app.plane.buildUserTurn
import io.rivethub.app.plane.compactCommandFor
import io.rivethub.app.plane.editAfterOutcome
import io.rivethub.app.plane.editForEnqueue
import io.rivethub.app.plane.restoredEdit
import io.rivethub.app.plane.PumpOutcome
import io.rivethub.app.plane.RejectReason
import io.rivethub.app.plane.CaptureFile
import io.rivethub.app.plane.CaptureRegistry
import io.rivethub.app.plane.CompactCheck
import io.rivethub.app.plane.capturesToSweep
import io.rivethub.app.plane.compactMayDispatch
import io.rivethub.app.plane.cardFromLiveTools
import io.rivethub.app.plane.chatItemForGate
import io.rivethub.app.plane.chatSendAction
import io.rivethub.app.plane.composerOnInput
import io.rivethub.app.plane.composerOnSendAttempt
import io.rivethub.app.plane.composerSendText
import io.rivethub.app.plane.composeAskAnswer
import io.rivethub.app.plane.defaultEffort
import io.rivethub.app.plane.defaultModel
import io.rivethub.app.plane.effortListFor
import io.rivethub.app.plane.isNativeImageMime
import io.rivethub.app.plane.mimeFromName
import io.rivethub.app.plane.modelAcceptsImage
import io.rivethub.app.plane.nativeImageAttachments
import io.rivethub.app.plane.nativeImageTurn
import io.rivethub.app.plane.nativeTurnModels
import io.rivethub.app.plane.optimisticUserText
import io.rivethub.app.plane.attachmentFetchUrl
import io.rivethub.app.plane.imageSourceNamespace
import io.rivethub.app.plane.editSource
import io.rivethub.app.plane.regenerateSource
import io.rivethub.app.plane.readyAttachments
import io.rivethub.app.plane.reconcileSummaryControls
import io.rivethub.app.plane.restoreQueuedComposer
import io.rivethub.app.plane.harnessGate
import io.rivethub.app.plane.harnessLabel
import io.rivethub.app.plane.nextInjectTry
import io.rivethub.app.plane.parseSessionMode
import io.rivethub.app.plane.persistSessionMode
import io.rivethub.app.plane.ptySpawnIsFresh
import io.rivethub.app.plane.rosterCommandFor
import io.rivethub.app.plane.sessionMatchesNative
import io.rivethub.app.plane.SpawnAttempt
import io.rivethub.app.plane.SpawnConflict
import io.rivethub.app.plane.SpawnNeedsConfirm
import io.rivethub.app.plane.forcedRetry
import io.rivethub.app.plane.agentAttemptFallbackError
import io.rivethub.app.plane.spawnAttempts
import io.rivethub.app.plane.spawnConflict
import io.rivethub.app.plane.spawnConflictStops
import io.rivethub.app.plane.spawnModelEffort
import io.rivethub.app.plane.spawnStopError
import io.rivethub.app.plane.spawnSuccessError
import io.rivethub.app.plane.PtyAttachCache
import io.rivethub.app.plane.SyncCoalescer
import io.rivethub.app.plane.TermAttachController
import io.rivethub.app.plane.TermScreenPort
import io.rivethub.app.plane.TermSocket
import io.rivethub.app.plane.TermSpawnPort
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.restartSessionPty
import io.rivethub.app.plane.terminalNodeIsRemote
import io.rivethub.app.plane.TermWatchFactory
import io.rivethub.app.plane.toSheet
import io.rivethub.app.plane.uploadBaseUrl
import io.rivethub.app.plane.uploadTooLarge
import io.rivethub.app.ui.term.AnsiScreen
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
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
import java.io.File
import java.util.UUID

/** Gap between a sync send and its one retry. Den drops a second sync inside 2 s. */
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
    private val initialTransport: String? = null,
    private val openStream: (Uri) -> java.io.InputStream? = { null },
    private val agentId: String = "",
    private val onAdoptPointer: ((from: String, canonical: String) -> Unit)? = null,
    /** Wall clock for the reasoning timer; injectable so tests can drive it. */
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    data class UiState(
        val title: String,
        val sessionId: String,
        val draft: Boolean,
        val mode: SessionMode = SessionMode.Chat,
        val model: String = "",
        val effort: String = "",
        val transport: String? = null,
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
        val codeLineNumbers: Boolean = false,
        val codeWrap: Boolean = false,
        val termCtrl: Boolean = false,
        val termAlt: Boolean = false,
        /** Session den is not the transport entry node. */
        val termRemote: Boolean = false,
        /** Attach failure from [TermAttachController], not the composer strip. */
        val termError: String? = null,
        val attachCommand: String? = null,
        val termClipboard: String? = null,
        /** Terminal owner (den #681); null = nobody owns it. Drives the ownership overlay. */
        val termOwner: io.rivethub.app.gateway.TermOwner? = null,
        /** Context-bar wire contract (null until the den reports it → model-derived fallback). */
        val contextWindow: Int? = null,
        val compactAt: Int? = null,
        val contextSource: String? = null,
        /** Composer editing a sent message (U5 banner; bubble-tap wiring lands in U3b). */
        val editing: EditState? = null,
        /** Model-sheet favourites (Settings `favouriteModels`). */
        val favouriteModels: Set<String> = emptySet(),
        /** PTY cwd from the spawn response. Null on older dens. */
        val spawnCwd: String? = null,
        /**
         * Set only for a recorded-directory 409. The attempt loop stops;
         * the user must confirm before a forced retry.
         */
        val spawnConflict: SpawnConflict? = null,
        /** Phone-measured reasoning span of the live turn (UX-SPEC §1.3); reset per turn. */
        val reasoning: ReasoningSpan? = null,
        /** Measured reasoning ms by stored turn index — in memory only; older turns have none. */
        val reasoningDurations: Map<Int, Long> = emptyMap(),
        /** Transport/turn error cards above the composer. Composer/attachment codes stay on [error]/[errorCode]. */
        val errors: List<ChatError> = emptyList(),
        /** Expanded chain-of-thought timelines by turn index; the live turn is -1. */
        val cotExpanded: Set<Int> = emptySet(),
        /** Generation of the live turn; a tool sheet opened on it stays with it (plane/ToolSheet.kt). */
        val liveTurn: Long = 0L,
        /** Settings → Messages (UX-SPEC §7): token stats line, action row always shown. */
        val showStats: Boolean = false,
        val actionRowAlways: Boolean = false,
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
            transport = initialTransport,
        ),
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Staged upload uri → the local content uri it came from (thumbnails; in memory only). */
    private val localPreviews = java.util.concurrent.ConcurrentHashMap<String, Uri>()

    /** Staged upload uri → the image bytes [stageBytes] sent (in memory, insertion order, bounded). */
    private val localPreviewBytes = LinkedHashMap<String, ByteArray>()

    private val machine = TranscriptMachine(nowMs = { System.currentTimeMillis() })
    private var attach: SessionAttach? = null
    private var sessionWatch: WsSubscription? = null
    private var registryWatch: Closeable? = null
    private val identityGen = c.identity.generation()
    private val ptyCache = PtyAttachCache()
    private var lastSpawn: TermSpawnResponse? = null
    /** The agentId attempt a recorded-directory 409 stopped on. */
    private var conflictAttempt: SpawnAttempt? = null
    private var descriptors: List<HarnessDescriptor> = emptyList()
    private var frames = Channel<Frame>(Channel.UNLIMITED)
    private var frameJob: Job? = null

    private sealed interface Frame {
        data class Ev(val e: HarnessEvent) : Frame
        data class St(val s: WsStatus) : Frame
    }

    private val pump = OutboundPump(
        send = { text, attachments ->
            val bubble = optimisticUserText(text, attachments)
            machine.appendOptimisticUser(bubble)
            machine.beginTurn()
            // Files the previous turn's span first: a queued send starts here
            // straight out of turn-complete, before that turn is on disk.
            beginLiveTurn()
            injectCompleted = false
            publishMachine()
            rearmIdleWatch()
            try {
                actuallySend(text, attachments)
                injectCompleted = true
                publishMachine()
            } catch (e: Throwable) {
                machine.revertOptimisticUser(bubble)
                // A 409 means a real turn IS streaming — dropping its bubble would
                // blank the reply the user is watching. Only a hard failure aborts.
                if (!isTurnInFlight(e)) machine.abortTurn()
                publishMachine()
                throw e
            }
        },
        attachmentsUploading = { anyUploading(_state.value.attachments) },
        onOutcome = { onPumpOutcome(it) },
    )

    /**
     * Every pump pass, from any entry point (send, inject, idle / turn-complete
     * edges, registry acknowledge), settles the item it touched: the Editing
     * banner riding on it clears only on [PumpOutcome.Dispatched]; a hard
     * failure puts that item's text, chips and edit back in the composer and
     * says why. A deferred or 409-queued item keeps its banner.
     */
    private fun onPumpOutcome(o: PumpOutcome) {
        when {
            o is PumpOutcome.Dispatched ->
                _state.update { it.copy(editing = editAfterOutcome(it.editing, o.item.id, o)) }
            o is PumpOutcome.Rejected && o.reason == RejectReason.FAILED -> _state.update {
                val item = o.item
                val restored = restoreQueuedComposer(it.composer, it.attachments, item.text, item.attachments)
                it.copy(
                    error = o.cause?.let { e -> e.message ?: e.javaClass.simpleName } ?: it.error,
                    composer = restored.text,
                    attachments = restored.attachments,
                    editing = editAfterOutcome(it.editing, item.id, o),
                )
            }
            else -> Unit
        }
    }

    private var idleWatch: Job? = null
    /** Post-turn settle flush for hook-sourced stores (H1). */
    private var settleJob: Job? = null
    /** One timer for the newest sync send. Re-armed on every send that opens
     *  a window. A snapshot does not cancel it. [startAttach] does. */
    private var syncRearm: Job? = null
    private val syncCoalescer = SyncCoalescer()

    private fun requestSync() {
        if (!syncCoalescer.onRequest()) return
        sessionWatch?.send("""{"type":"sync"}""")
        armSyncRearm()
    }

    /**
     * One timer per opening send, replaced on every such send. The fire writes
     * the one retry and does not arm another timer: [SyncCoalescer.onRearm]
     * has closed the window, and a leftover timer could close a newer send's
     * window. Launch the replacement before cancelling [syncRearm] so that
     * cancel cannot take the new timer with it. A failed write is still a
     * send — the retry fires either way.
     */
    private fun armSyncRearm() {
        val previous = syncRearm
        val next = viewModelScope.launch {
            delay(SYNC_REARM_MS)
            if (!syncCoalescer.onRearm()) return@launch
            sessionWatch?.send("""{"type":"sync"}""")
        }
        syncRearm = next
        if (previous != null && previous != next) previous.cancel()
    }
    private val spawnMu = Mutex()
    private var lastRegistryStatus: String? = null
    private var lastRegistryUpdatedAt: String? = null
    /** True after inject ok / sendTurn landed — a fetch before this cannot complete the turn. */
    private var injectCompleted: Boolean = false

    /** Reasoning clock (plane/ReasoningClock.kt): the live span plus finished measurements keyed by
     *  their turn start until those turns land on disk. [wasInFlight] = previous publish's inFlight. */
    private var ledger = ReasoningLedger()
    private var wasInFlight: Boolean = false
    /** Live-turn generation for the tool sheet's identity (plane/ToolSheet.kt); bumped per turn start. */
    private var liveTurnGen: Long = 0L
    private var errorSeq: Long = 0L
    /** Terminal errors already stacked this session: the controller republishes its error on every change. */
    private var termErrorGate = RepeatErrorGate()

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
            // Stack each new terminal failure once; the retry surface keeps reading termError.
            val termErr = v.error
            val (gate, stack) = termErrorGate.admit(_state.value.sessionId, termErr)
            termErrorGate = gate
            if (stack && termErr != null) _state.update { it.copy(errors = stackError(it.errors, termErr)) }
            _state.update {
                it.copy(
                    termStatus = v.status,
                    termRev = v.rev,
                    termCtrl = v.ctrl,
                    termAlt = v.alt,
                    termError = v.error,
                    attachCommand = v.attachCommand,
                    termClipboard = v.clipboard,
                    termOwner = v.owner,
                )
            }
        },
    )

    fun terminalScreen(): AnsiScreen = termScreen

    init {
        viewModelScope.launch { boot() }
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                _state.update { it.copy(termFontSp = p.terminalFontSp, codeLineNumbers = p.codeLineNumbers, codeWrap = p.codeWrap, favouriteModels = p.favouriteModels, termRemote = terminalNodeIsRemote(nodeDenUrl, p.entryUrl), showStats = p.showStats, actionRowAlways = p.actionRowAlways) }
            }
        }
    }

    fun clearComposer() { _state.update { it.copy(composer = "") } }

    fun setComposer(v: String) {
        val edit = composerOnInput(v)
        _state.update { it.copy(composer = edit.value, error = edit.error) }
    }
    fun setMoreOpen(v: Boolean) = _state.update { it.copy(moreOpen = v) }

    fun setMode(mode: SessionMode) {
        val resync = _state.value.mode == SessionMode.Terminal && mode == SessionMode.Chat
        _state.update { it.copy(mode = mode) }
        viewModelScope.launch { c.settings.setSessionMode(_state.value.sessionId, persistSessionMode(mode)) }
        if (resync) syncNow()
    }

    /** Re-fetch the transcript. Terminal to Chat calls this so new turns show up. */
    fun syncNow() = requestSync()

    fun setModel(id: String) {
        val sheet = _state.value.sheet
        val effort = defaultEffort(sheet, id)
        _state.update { it.copy(model = id, effort = effort) }
    }

    fun setEffort(id: String) = _state.update { it.copy(effort = id) }

    /** Recorded-directory confirm. Re-runs that attempt with force. Never automatic. */
    fun resumeHereAnyway() {
        val attempt = conflictAttempt ?: return
        conflictAttempt = null
        val forced = forcedRetry(attempt)
        _state.update { it.copy(spawnConflict = null) }
        viewModelScope.launch {
            try {
                val spawned = spawnMu.withLock {
                    val existing = ptyCache.cached()
                    if (existing != null) {
                        lastSpawn ?: TermSpawnResponse(id = existing)
                    } else {
                        val response = withContext(Dispatchers.IO) {
                            gateway().termSpawn(
                                session = forced.session,
                                cols = 80,
                                rows = 24,
                                command = forced.command,
                                model = forced.model,
                                effort = forced.effort,
                                agentId = forced.agentId,
                                force = true,
                            )
                        }
                        ptyCache.remember(response.id)
                        lastSpawn = response
                        response
                    }
                }
                _state.update { it.copy(spawnCwd = spawned.cwd, spawnConflict = null) }
                if (_state.value.mode == SessionMode.Terminal) termCtl.ensure()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
            }
        }
    }

    fun dismissSpawnConflict() {
        conflictAttempt = null
        _state.update { it.copy(spawnConflict = null) }
    }

    /** Composer text + staged turn attachments, validated; null after publishing the refusal. */
    private data class PreparedSend(val text: String, val atts: List<StagedTurnAttachment>, val keptComposer: String)

    private fun prepareOutbound(st: UiState): PreparedSend? {
        if (anyUploading(st.attachments)) {
            _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_UPLOADING) }
            return null
        }
        if (anyFailed(st.attachments)) {
            _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_FAILED_ATTACHMENT) }
            return null
        }
        val nativeImages = nativeImageAttachments(st.sheet, st.transport)
        val staged = readyAttachments(st.attachments)
        if (nativeImages && staged.isNotEmpty()) {
            if (staged.any { !isNativeImageMime(it.mime) }) {
                _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_IMAGE_ONLY) }
                return null
            }
            val selected = st.sheet?.models?.find { it.id == st.model }
            if (!modelAcceptsImage(selected)) {
                _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_IMAGE_UNSUPPORTED) }
                return null
            }
        }
        val text = composerSendText(st.composer, st.attachments, nativeImages)
        val enqueueAtts = if (nativeImageTurn(staged, nativeImages)) staged else emptyList()
        if (text.isBlank() && enqueueAtts.isEmpty()) return null
        return PreparedSend(text, enqueueAtts, st.composer)
    }

    fun send() {
        val st = _state.value
        val out = prepareOutbound(st) ?: return
        val text = out.text
        val enqueueAtts = out.atts
        val keptComposer = out.keptComposer
        _state.update { it.copy(composer = "", attachments = emptyList(), error = composerOnSendAttempt(), errorCode = null) }
        // The edit rides on the queued item: local enqueue is not acceptance, so
        // the banner settles in [onPumpOutcome] when THIS item is dispatched or fails.
        when (pump.tryEnqueue(text, enqueueAtts, editing = editForEnqueue(st.editing, pump.queued))) {
            is EnqueueResult.Uploading -> {
                _state.update { it.copy(composer = keptComposer, attachments = st.attachments, errorCode = ERR_UPLOADING) }
            }
            is EnqueueResult.Accepted -> pumpAccepted { s, _ -> s } // a hard failure is surfaced and restored by onPumpOutcome
        }
    }

    /** Pump a just-accepted outbound item; [onFailure] folds a send failure into state. */
    private fun pumpAccepted(onFailure: (UiState, Throwable) -> UiState) {
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
                _state.update { onFailure(it, e) }
            }
        }
    }

    /**
     * Regenerate (UX-SPEC §1.3; the screen confirms first): the den has no
     * replace route, so the nearest preceding user text (attachment lines
     * stripped) goes out again as a NEW turn through the normal send path.
     * The composer is left alone.
     */
    fun regenerate(index: Int) {
        val st = _state.value
        if (st.inFlight) return
        val text = regenerateSource(st.turns, index) ?: return
        when (pump.tryEnqueue(text)) {
            is EnqueueResult.Uploading -> _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_UPLOADING) }
            is EnqueueResult.Accepted -> pumpAccepted { s, e -> s.copy(errors = stackError(s.errors, e)) }
        }
    }

    /**
     * Tap-to-edit on a user bubble: pre-fill the composer with that turn's
     * text (attachments stripped); Send submits it as a NEW turn.
     */
    fun editFromTurn(index: Int) {
        val text = editSource(_state.value.turns, index) ?: return
        beginEditCompat(text)
    }

    /**
     * Shim for slice U5's composer edit API (`beginEdit(text)` + the
     * "Editing ✕" banner), which is not in this tree. The integrator replaces
     * this body with `beginEdit(text)` at merge.
     */
    private fun beginEditCompat(text: String) = setComposer(text)

    /**
     * The namespace [attachmentBytes] resolves uris in (session node origin +
     * identity generation), for the process-wide thumbnail cache key.
     */
    val attachmentNamespace: String = imageSourceNamespace(nodeDenUrl, identityGen)

    /**
     * Bytes for an attachment thumbnail. A file this VM uploaded is read back
     * from its local content uri (or, for [stageBytes], the bytes it kept);
     * otherwise a vetted same-node url ([attachmentFetchUrl]) is fetched with
     * the device mTLS client. Null when none exists (the den serves no GET for
     * staged uploads) — the chip then falls back to a named pill. Cancelling
     * the caller cancels the read and rethrows CancellationException.
     */
    suspend fun attachmentBytes(uri: String): ByteArray? {
        synchronized(localPreviewBytes) { localPreviewBytes[uri] }?.let { return it }
        localPreviews[uri]?.let { local ->
            return withContext(Dispatchers.IO) {
                try {
                    openStream(local)?.let { readCapped(it, PREVIEW_MAX_BYTES) { ensureActive() } }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    null
                }
            }
        }
        val url = attachmentFetchUrl(uri, nodeDenUrl) ?: return null
        return try {
            c.harness(nodeDenUrl).fetchBytes(url, PREVIEW_MAX_BYTES)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Keeps [bytes] as the in-session preview for staged [uri]. The kept set is
     * bounded to PREVIEW_MAX_BYTES in total; the oldest entries go first.
     */
    private fun keepPreviewBytes(uri: String, bytes: ByteArray) {
        if (bytes.size.toLong() > PREVIEW_MAX_BYTES) return
        synchronized(localPreviewBytes) {
            localPreviewBytes[uri] = bytes
            var total = localPreviewBytes.values.sumOf { it.size.toLong() }
            val iter = localPreviewBytes.entries.iterator()
            while (total > PREVIEW_MAX_BYTES && iter.hasNext()) {
                val e = iter.next()
                if (e.key == uri) continue
                total -= e.value.size.toLong()
                iter.remove()
            }
        }
    }

    /**
     * Long-press Send while a turn is in flight (UX-SPEC §4): put the composer
     * on the outbound queue WITHOUT pumping — the pump drains it on the next
     * idle / turn-complete edge, and the queued strip offers inject / cancel.
     * Same validation and `[attached: …]` text as [send]; refused while a chip
     * is still uploading ([ERR_UPLOADING]).
     */
    fun enqueueSend() {
        val st = _state.value
        val out = prepareOutbound(st) ?: return
        // Queued is not accepted: the edit rides on the item until it is dispatched.
        when (pump.tryEnqueue(out.text, out.atts, editing = editForEnqueue(st.editing, pump.queued))) {
            is EnqueueResult.Uploading -> {
                _state.update { it.copy(error = composerOnSendAttempt(), errorCode = ERR_UPLOADING) }
            }
            is EnqueueResult.Accepted -> {
                _state.update {
                    it.copy(
                        composer = "",
                        attachments = emptyList(),
                        error = composerOnSendAttempt(),
                        errorCode = null,
                    )
                }
                publishMachine()
            }
        }
    }

    /** Put [text] back in the composer with the "Editing ✕" banner (bubble-tap arrives in U3b). */
    fun beginEdit(text: String) {
        _state.update { it.copy(editing = beginEditState(text), composer = text, error = null, errorCode = null) }
    }

    /** Leave editing mode: banner gone, composer emptied. */
    fun cancelEdit() {
        _state.update { it.copy(editing = null, composer = "") }
    }

    /**
     * "+" → Compress context: type the harness compaction command into the
     * session PTY, the same path as the stale-409 fallback in [sendAdopted]
     * (ensurePty on the native id, wait-ready when fresh, termInject). Claude
     * only ([compactCommandFor]); never mid-turn, never on a draft.
     *
     * The PTY setup suspends, so a send can start meanwhile. The inject runs
     * under the pump's send lock ([OutboundPump.withSendLock]) and re-checks
     * [compactMayDispatch] there: a turn in flight, a queued / sending item,
     * a draft or a different session drops the compaction (strip error) —
     * and no pump send can begin between that check and the inject.
     */
    fun compactContext() {
        val st = _state.value
        val hid = resolvedHarnessId()
        val before = compactCheck(st)
        if (!compactMayDispatch(hid, before, before)) {
            // Confirm outlived the idle state (a turn or queued send started under
            // the dialog): explain the no-op, as the post-setup refusal does.
            if (compactCommandFor(hid) != null) _state.update { it.copy(errorCode = ERR_COMPACT_BUSY) }
            return
        }
        val cmd = compactCommandFor(hid) ?: return
        val native = nativeIdOf(st.sessionId) ?: return
        viewModelScope.launch {
            try {
                val pty = ensurePty(sessionOverride = native)
                if (pty.fresh) waitUntilPtyReady(pty.id)
                val sent = pump.withSendLock {
                    val now = compactCheck(_state.value)
                    if (!compactMayDispatch(hid, before, now)) return@withSendLock false
                    withContext(Dispatchers.IO) { gateway().termInject(session = native, text = cmd) }
                    true
                }
                if (!sent) {
                    AndroidLogger.debug("RivetHub", "compact dropped: a turn or send started during PTY setup", null)
                    _state.update { it.copy(errorCode = ERR_COMPACT_BUSY) }
                }
            } catch (e: Exception) {
                AndroidLogger.warn("RivetHub", "compact inject failed: ${e.javaClass.simpleName}: ${e.message}", e)
                _state.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
            }
        }
    }

    private fun compactCheck(st: UiState) = CompactCheck(
        sessionId = st.sessionId,
        draft = st.draft,
        inFlight = st.inFlight || machine.inFlight,
        outboundBusy = pump.busy,
    )

    /**
     * Model sheet long-press: add / remove [id] in ONE settings transaction
     * ([io.rivethub.app.data.Settings.toggleFavouriteModel]), then publish the
     * committed set — overlapping toggles serialise in DataStore.
     */
    fun toggleFavouriteModel(id: String) {
        viewModelScope.launch {
            val committed = c.settings.toggleFavouriteModel(id)
            _state.update { it.copy(favouriteModels = committed) }
        }
    }

    /** Entries of the composer "+" panel for this session right now. */
    fun plusItems(): List<PlusItem> {
        val st = _state.value
        return plusPanelItems(resolvedHarnessId(), st.inFlight, st.draft)
    }

    fun stop() {
        val st = _state.value
        if (!st.gate.canInterrupt || st.draft) return
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { c.harness(nodeDenUrl).interrupt(sessionKeyEnc(st.sessionId)) }
        }
    }

    fun answerAsk(picked: Map<Int, List<String>>, freeByQuestion: Map<Int, String>) {
        val st = _state.value
        // In-flight guard (web keeps the same ref): every option row is a submit
        // surface now, and a second POST for the same promptId would type the
        // old answer's digit into the NEXT screen-read question.
        if (st.answeringPrompt) return
        val card = st.ask ?: return
        val promptId = st.promptId
        if (promptId != null) {
            val answers = promptAnswers(card.questions, picked, freeByQuestion)
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
                            it.copy(answeringPrompt = false, errors = stackError(it.errors, e))
                        }
                    }
                }.onSuccess {
                    _state.update { it.copy(answeringPrompt = false, askError = null) }
                }
            }
            return
        }
        val free = card.questions.indices.mapNotNull { i ->
            freeByQuestion[i]?.trim()?.takeIf { it.isNotEmpty() }
        }.joinToString("\n")
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
                _state.update { it.copy(errors = stackError(it.errors, e)) }
            }
        }
    }

    fun cancelQueued(id: String) {
        viewModelScope.launch {
            val item = pump.cancel(id) ?: return@launch
            _state.update {
                val restored = restoreQueuedComposer(it.composer, it.attachments, item.text, item.attachments)
                it.copy(
                    composer = restored.text,
                    attachments = restored.attachments,
                    editing = restoredEdit(it.editing, item),
                    queued = pump.queued,
                )
            }
        }
    }

    fun injectQueued(id: String) {
        val st = _state.value
        if (pump.queued.none { it.id == id }) return
        viewModelScope.launch {
            if (st.inFlight && st.gate.canInterrupt && !st.draft) {
                runCatching {
                    withContext(Dispatchers.IO) { c.harness(nodeDenUrl).interrupt(sessionKeyEnc(st.sessionId)) }
                }
            }
            try {
                pump.pump(forceId = id)
            } catch (e: Throwable) {
                // A hard failure dropped the item; onPumpOutcome already handed its
                // text, chips and edit back and set the error.
                AndroidLogger.warn("RivetHub", "inject failed: ${e.javaClass.simpleName}: ${e.message}", e)
            }
            publishMachine()
        }
    }

    /** Camera files in use (pending capture or uploading); never swept. */
    private val captures = CaptureRegistry()

    /** The camera is being launched into [name] — hold it until the result comes back. */
    fun captureStarted(name: String) = captures.hold(name)

    /** The camera came back without a photo; the launcher deletes the file. */
    fun captureAbandoned(name: String) = captures.release(name)

    /**
     * Stage a camera capture: [file] stays held through its upload; once it
     * staged successfully, stale unheld captures in its directory are swept
     * (not before the next capture — the previous one may still be live).
     */
    fun stageCapture(uri: Uri, file: File) {
        val name = file.name
        captures.hold(name)
        stageUri(uri, name, "image/jpeg", file.length()) { ok ->
            captures.release(name)
            if (ok) sweepCaptures(file.parentFile ?: return@stageUri)
        }
    }

    private fun sweepCaptures(dir: File) {
        val held = captures.held()
        val now = System.currentTimeMillis()
        viewModelScope.launch(Dispatchers.IO) {
            val files = dir.listFiles()?.filter { it.isFile }.orEmpty()
            val doomed = capturesToSweep(files.map { CaptureFile(it.name, it.lastModified()) }, held, now).toSet()
            files.filter { it.name in doomed }.forEach { it.delete() }
        }
    }

    fun stageUri(uri: Uri, name: String, mime: String?, size: Long, onDone: (ok: Boolean) -> Unit = {}) {
        val id = UUID.randomUUID().toString()
        val resolvedMime = mime?.takeIf { it.isNotBlank() } ?: mimeFromName(name)
        if (uploadTooLarge(size)) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED),
                    errorCode = ERR_TOO_LARGE,
                )
            }
            onDone(false)
            return
        }
        val nativeImages = nativeImageAttachments(_state.value.sheet, _state.value.transport)
        if (nativeImages && !isNativeImageMime(resolvedMime)) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED, mime = resolvedMime),
                    errorCode = ERR_IMAGE_ONLY,
                )
            }
            onDone(false)
            return
        }
        _state.update {
            it.copy(attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.UPLOADING, mime = resolvedMime), errorCode = null)
        }
        viewModelScope.launch {
            val entry = c.settings.snapshot().entryUrl
            val base = uploadBaseUrl(nodeDenUrl, entry)
            try {
                val staged = withContext(Dispatchers.IO) {
                    c.harness(base).stageUpload(if (size >= 0) size else -1L, name, resolvedMime) {
                        openStream(uri) ?: throw java.io.IOException("could not open attachment")
                    }
                }
                if (resolvedMime?.startsWith("image/") == true) localPreviews[staged.uri] = uri
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.READY, uri = staged.uri, mime = resolvedMime ?: a.mime) else a
                        },
                    )
                }
                onDone(true)
            } catch (e: Exception) {
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.FAILED) else a
                        },
                        errors = stackError(s.errors, e),
                    )
                }
                onDone(false)
            }
        }
    }

    fun stageBytes(bytes: ByteArray, name: String, mime: String?) {
        val id = UUID.randomUUID().toString()
        val resolvedMime = mime?.takeIf { it.isNotBlank() } ?: mimeFromName(name)
        if (uploadTooLarge(bytes.size.toLong())) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED),
                    errorCode = ERR_TOO_LARGE,
                )
            }
            return
        }
        val nativeImages = nativeImageAttachments(_state.value.sheet, _state.value.transport)
        if (nativeImages && !isNativeImageMime(resolvedMime)) {
            _state.update {
                it.copy(
                    attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.FAILED, mime = resolvedMime),
                    errorCode = ERR_IMAGE_ONLY,
                )
            }
            return
        }
        _state.update {
            it.copy(attachments = it.attachments + PendingAttachment(id, name, AttachmentStatus.UPLOADING, mime = resolvedMime))
        }
        viewModelScope.launch {
            val entry = c.settings.snapshot().entryUrl
            val base = uploadBaseUrl(nodeDenUrl, entry)
            try {
                val staged = withContext(Dispatchers.IO) {
                    c.harness(base).stageUpload(bytes, name, resolvedMime)
                }
                if (resolvedMime?.startsWith("image/") == true) keepPreviewBytes(staged.uri, bytes)
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.READY, uri = staged.uri, mime = resolvedMime ?: a.mime) else a
                        },
                    )
                }
            } catch (e: Exception) {
                _state.update { s ->
                    s.copy(
                        attachments = s.attachments.map { a ->
                            if (a.id == id) a.copy(status = AttachmentStatus.FAILED) else a
                        },
                        errors = stackError(s.errors, e),
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
        AndroidLogger.debug("RivetHub", "term ensure: draft=${_state.value.draft} session=${_state.value.sessionId} pty=${ptyCache.id}", null)
        termCtl.ensure()
    }

    fun onAppBackground() = termCtl.onBackground()

    fun onAppForeground() = termCtl.onForeground()

    fun userDetachTerminal() = termCtl.userDetach()

    fun resizeTerminal(cols: Int, rows: Int) = termCtl.resize(cols, rows)

    /** "Use terminal here" — claim terminal ownership from the other device. */
    fun claimTerminal() = termCtl.claimTerminal()

    fun sendTermBytes(bytes: ByteArray) = termCtl.sendBytes(bytes)

    /** IME replace-edit DEL burst: do not consume ALT. */
    fun sendTermBytesRaw(bytes: ByteArray) = termCtl.sendBytesRaw(bytes)

    fun sendTermText(text: String) {
        if (text.isEmpty() || OscFilter.isColorReport(text)) return
        termCtl.sendText(text)
    }

    fun toggleTermCtrl() = termCtl.toggleCtrl()

    fun lockTermCtrl() = termCtl.lockCtrl()

    fun toggleTermAlt() = termCtl.toggleAlt()

    /** Drop the cached PTY id, detach, spawn-or-get again. Never kill. */
    fun restartTerminal() = restartSessionPty(ptyCache) { termCtl.restart() }

    /** Sheet label for the harness id, used when [UiState.model] is blank. */
    fun harnessDisplayLabel(): String = harnessLabel(resolvedHarnessId())

    fun consumeTermClipboard() = termCtl.consumeClipboard()

    private suspend fun boot() {
        val prefs = c.settings.snapshot()
        val mode = parseSessionMode(prefs.sessionModes[_state.value.sessionId])
        _state.update { it.copy(mode = mode, termFontSp = prefs.terminalFontSp, codeLineNumbers = prefs.codeLineNumbers, codeWrap = prefs.codeWrap, termRemote = terminalNodeIsRemote(nodeDenUrl, prefs.entryUrl)) }
        if (c.identity.generation() != identityGen) return
        try {
            val hg = c.harness(nodeDenUrl)
            val desc = withContext(Dispatchers.IO) { runCatching { hg.listHarnesses() }.getOrDefault(emptyList()) }
            descriptors = desc
            val hid = resolvedHarnessId()
            val caps = desc.find { it.harnessId == hid }?.capabilities
            val sheet = caps?.toSheet()
            var transport = _state.value.transport
            var summaryModel: String? = null
            var summaryEffort: String? = null
            if (!_state.value.draft && hid != null && caps != null && initialTransport == null) {
                val sessions = withContext(Dispatchers.IO) {
                    runCatching { hg.listSessions(hid, caps) }.getOrDefault(emptyList())
                }
                val row = sessions.find { sessionMatchesNative(it.sessionId, _state.value.sessionId) }
                if (row != null) {
                    transport = row.transport ?: transport
                    summaryModel = row.model
                    summaryEffort = row.effort
                }
            }
            val nativeModels = nativeTurnModels(sheet, transport)
            val model = when {
                nativeModels.isNotEmpty() ->
                    nativeModels.find { it.id == presetModel }?.id
                        ?: nativeModels.find { it.id == summaryModel }?.id
                        ?: nativeModels.find { it.default }?.id
                        ?: nativeModels.first().id
                else -> presetModel.ifBlank { defaultModel(sheet) }
            }
            val effort = when {
                nativeModels.isNotEmpty() -> {
                    val selected = nativeModels.find { it.id == model }
                    val efforts = selected?.efforts.orEmpty()
                    efforts.find { it.id == presetEffort }?.id
                        ?: efforts.find { it.id == summaryEffort }?.id
                        ?: efforts.find { it.default }?.id
                        ?: efforts.firstOrNull()?.id
                        ?: ""
                }
                else -> presetEffort.ifBlank { defaultEffort(sheet, model) }
            }
            _state.update { it.copy(sheet = sheet, model = model, effort = effort, transport = transport) }
            recomputeGate()
        } catch (e: Exception) {
            _state.update { it.copy(errors = stackError(it.errors, e)) }
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
                    applySummaryControls(event.summary.transport, event.summary.model, event.summary.effort)
                    adoptCanonical(sid)
                    maybeRegistryResync(event)
                }
            }
            is HarnessEvent.CapabilitiesChanged -> {
                if (event.harnessId == resolvedHarnessId()) {
                    descriptors = descriptors.map { d ->
                        if (d.harnessId == event.harnessId) d.copy(capabilities = event.capabilities) else d
                    }
                    if (descriptors.none { it.harnessId == event.harnessId }) {
                        descriptors = descriptors + io.rivethub.app.gateway.HarnessDescriptor(
                            event.harnessId, event.capabilities,
                        )
                    }
                    _state.update { it.copy(sheet = event.capabilities.toSheet()) }
                    applySummaryControls(null, null, null)
                    recomputeGate()
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
        syncCoalescer.abandon()
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
                _state.update { it.copy(errors = stackError(it.errors, msg), ws = WsStatus.CLOSED) }
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
                                // A from-zero snapshot is not this phone's response.
                                // It must not touch the coalescer or the timer. A
                                // rev-gap still goes through requestSync.
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
                                // File this turn's measurement BEFORE draining the queue: the
                                // pump can start the next send synchronously.
                                updateLedger { it.fileSpan(clock()) }
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
                                when (e) {
                                    is HarnessEvent.ReasoningDelta -> updateLedger { it.reasoningDelta(clock()) }
                                    is HarnessEvent.AssistantDelta, is HarnessEvent.ToolUse ->
                                        updateLedger { it.nonReasoning(clock()) }
                                    else -> Unit
                                }
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

    private suspend fun actuallySend(text: String, attachments: List<StagedTurnAttachment>) {
        if (c.identity.generation() != identityGen) {
            AndroidLogger.debug("RivetHub", "send dropped: identity generation changed", null)
            return
        }
        AndroidLogger.debug("RivetHub", "send: draft=${_state.value.draft} session=${_state.value.sessionId} node=$nodeDenUrl", null)
        val st = _state.value
        when (val action = chatSendAction(st.draft, st.sessionId, text)) {
            is ChatSendAction.Inject -> injectDraft(action)
            is ChatSendAction.SendTurn -> sendAdopted(action, attachments)
        }
    }

    private suspend fun sendAdopted(action: ChatSendAction.SendTurn, attachments: List<StagedTurnAttachment>) {
        val hg = c.harness(nodeDenUrl)
        val st = _state.value
        val turn = buildUserTurn(action.text, attachments, st.sheet, st.transport, st.model, st.effort)
        val accepted = try {
            withContext(Dispatchers.IO) {
                hg.sendTurn(sessionKeyEnc(action.sessionId), turn)
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
                AndroidLogger.debug("RivetHub", "inject ok: session=${action.sessionId} pty=${ptyCache.id}", null)
                injectCompleted = true
                return
            } catch (e: Exception) {
                if (e is SpawnNeedsConfirm || e is kotlinx.coroutines.CancellationException) throw e
                if (nextInjectTry(failed = true, alreadyRetried = retried) == null) throw e
                retried = true
                ptyCache.forget()
            }
        }
    }

    private data class PtySlot(val id: String, val fresh: Boolean)

    private suspend fun ensurePty(sessionOverride: String? = null): PtySlot = spawnMu.withLock {
        ptyCache.cached()?.let { return@withLock PtySlot(it, fresh = false) }
        val st = _state.value
        val command = rosterCommandFor(harnessId)
        val flags = spawnModelEffort(st.sheet, harnessId, st.model, st.effort)
        val gw = gateway()
        val attempts = spawnAttempts(
            sessionOverride ?: st.sessionId,
            command,
            flags.model,
            flags.effort,
            agentId,
        )
        var last: Exception? = null
        var surfaced: String? = null
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
                        agentId = attempt.agentId,
                        force = if (attempt.force) true else null,
                    )
                }
                val fresh = ptySpawnIsFresh(alreadyHeld = false, reattached = spawned.reattached)
                ptyCache.remember(spawned.id)
                lastSpawn = spawned
                _state.update { stNow ->
                    stNow.copy(
                        spawnCwd = spawned.cwd,
                        spawnConflict = null,
                        // A continued agentId failure stays on the strip. A stop throws
                        // before this update. The next send clears the text.
                        error = spawnSuccessError(stNow.error, surfaced),
                    )
                }
                AndroidLogger.debug(
                    "RivetHub",
                    "spawned pty=${spawned.id} for session=${attempt.session} cmd=${attempt.command} agent=${attempt.agentId} cwd=${spawned.cwd}",
                    null,
                )
                return@withLock PtySlot(spawned.id, fresh)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                val http = e as? GatewayException
                if (http != null && !attempt.agentId.isNullOrBlank()) {
                    val conflict = spawnConflict(http.status, http.message)
                    if (conflict != null && spawnConflictStops(conflict)) {
                        if (conflict == SpawnConflict.RecordedDir) {
                            conflictAttempt = attempt
                            _state.update { it.copy(spawnConflict = conflict) }
                            throw SpawnNeedsConfirm()
                        }
                        val text = spawnStopError(conflict, http.message, http.status)
                        _state.update { it.copy(error = text, spawnConflict = null) }
                        throw SpawnNeedsConfirm()
                    }
                    val fallback = agentAttemptFallbackError(http.status, http.message)
                    if (fallback != null) {
                        surfaced = fallback
                        _state.update { it.copy(error = fallback) }
                    }
                }
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
        val split = splitHermesReasoning(machine.liveText)
        val thinking = machine.liveReasoning.ifBlank { split.reasoning }
        val st = machine.agentStatus
        val now = clock()
        val inFlightNow = machine.inFlight
        val advanced = ledger.advance(
            nowMs = now,
            wasInFlight = wasInFlight,
            inFlight = inFlightNow,
            reasoningSeen = thinking.isNotBlank(),
            nonReasoningSeen = split.text.isNotBlank() || machine.liveTools.isNotEmpty(),
            committedSize = machine.committedTurns.size,
        )
        if (!wasInFlight && inFlightNow) liveTurnGen++
        wasInFlight = inFlightNow
        val transcript = machine.transcript
        val settled = advanced.settle(transcript, inFlightNow, ::turnHasReasoning)
        ledger = settled.ledger
        _state.update {
            it.copy(
                reasoning = ledger.span,
                reasoningDurations = if (settled.durations.isEmpty()) it.reasoningDurations else it.reasoningDurations + settled.durations,
                liveTurn = liveTurnGen,
                turns = transcript,
                liveText = machine.liveText,
                liveReasoning = thinking,
                liveTools = machine.liveTools,
                inFlight = machine.inFlight,
                queued = pump.queued.filter { q -> q.status == OutboundItem.Status.QUEUED },
                agentStatusText = agentStatusLine(st?.status, st?.phase, st?.toolName),
            )
        }
    }

    private fun updateLedger(f: (ReasoningLedger) -> ReasoningLedger) {
        ledger = f(ledger)
        _state.update { it.copy(reasoning = ledger.span) }
    }

    /** A send starts a turn: file the old span, reset the clock and the live-turn identity. */
    private fun beginLiveTurn() {
        ledger = ledger.startTurn(clock(), machine.committedTurns.size)
        liveTurnGen++
        // machine.beginTurn() already set inFlight; the publish that follows must not start it again.
        wasInFlight = machine.inFlight
        _state.update { it.copy(reasoning = ledger.span, liveTurn = liveTurnGen) }
    }

    /** Hermes keeps its reasoning in the text, so an owner check looks there too. */
    private fun turnHasReasoning(t: io.rivethub.app.gateway.HarnessTranscriptTurn): Boolean =
        !t.thinking.isNullOrBlank() || splitHermesReasoning(t.text).reasoning.isNotBlank()

    /** Clock for the live "Reasoned for" label, so it ticks on the same time base as the span. */
    val clockMs: () -> Long get() = clock

    private fun stackError(list: List<ChatError>, e: Throwable): List<ChatError> =
        stackError(list, e.message ?: e.javaClass.simpleName)

    private fun stackError(list: List<ChatError>, text: String, code: String? = null): List<ChatError> =
        pushError(list, text, code, id = ++errorSeq)

    fun dismissError(id: Long) = _state.update { it.copy(errors = dismissChatError(it.errors, id)) }

    fun clearErrors() = _state.update { it.copy(errors = clearChatErrors(it.errors)) }

    /** Expand/fold one turn's chain-of-thought timeline; the live turn is -1. */
    fun toggleCot(turnIndex: Int) = _state.update {
        it.copy(cotExpanded = if (turnIndex in it.cotExpanded) it.cotExpanded - turnIndex else it.cotExpanded + turnIndex)
    }

    fun effortOptions(): List<Pair<String, String>> {
        val st = _state.value
        val native = nativeTurnModels(st.sheet, st.transport)
        if (native.isNotEmpty()) {
            val selected = native.find { it.id == st.model } ?: native.firstOrNull()
            return selected?.efforts.orEmpty().map { it.id to it.label }
        }
        return effortListFor(st.sheet, st.model).map { it.id to it.label }
    }

    fun nativeModels(): List<Pair<String, String>> {
        val st = _state.value
        return nativeTurnModels(st.sheet, st.transport).map { it.id to it.label }
    }

    fun nativeImagesEnabled(): Boolean = nativeImageAttachments(_state.value.sheet, _state.value.transport)

    private fun resolvedHarnessId(): String? {
        if (!harnessId.isNullOrBlank()) return harnessId
        val sid = _state.value.sessionId
        val i = sid.indexOf(':')
        if (i <= 0) return null
        val hid = sid.substring(0, i)
        return hid.takeIf { it in HARNESS_IDS }
    }

    private fun applySummaryControls(transport: String?, model: String?, effort: String?) {
        _state.update { st ->
            val next = reconcileSummaryControls(
                sheet = st.sheet,
                currentTransport = st.transport,
                currentModel = st.model,
                currentEffort = st.effort,
                incomingTransport = transport,
                incomingModel = model,
                incomingEffort = effort,
            )
            st.copy(transport = next.transport, model = next.model, effort = next.effort)
        }
    }

    companion object {
        const val ERR_UPLOADING = ERR_CODE_UPLOADING
        const val ERR_TOO_LARGE = ERR_CODE_TOO_LARGE
        const val ERR_FAILED_ATTACHMENT = ERR_CODE_FAILED_ATTACHMENT
        const val ERR_IMAGE_ONLY = ERR_CODE_IMAGE_ONLY
        const val ERR_IMAGE_UNSUPPORTED = ERR_CODE_IMAGE_UNSUPPORTED
        const val ERR_COMPACT_BUSY = "compact_busy"

        /** Largest attachment body read for a thumbnail or the full-screen view. */
        const val PREVIEW_MAX_BYTES: Long = 20L * 1024L * 1024L
    }
}
