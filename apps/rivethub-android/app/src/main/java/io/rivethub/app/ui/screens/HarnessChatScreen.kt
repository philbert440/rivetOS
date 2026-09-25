package io.rivethub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.rivethub.app.R
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.plane.findChatItem
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.titleBlock
import io.rivethub.app.plane.renameAllowed
import io.rivethub.app.plane.harnessLabel
import io.rivethub.app.plane.searchTurns
import io.rivethub.app.plane.highlightRanges
import io.rivethub.app.plane.SearchHit
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.PlusItem
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.SpawnConflict
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.modelDisplayLabel
import io.rivethub.app.plane.terminalTitle
import io.rivethub.app.plane.TranscriptPin
import io.rivethub.app.plane.accentFor
import io.rivethub.app.plane.composerCanSend
import io.rivethub.app.plane.composerIsEnabled
import io.rivethub.app.plane.contextBarView
import io.rivethub.app.plane.CotStep
import io.rivethub.app.plane.cotSteps
import io.rivethub.app.plane.foldSteps
import io.rivethub.app.plane.LIVE_TURN_INDEX
import io.rivethub.app.plane.ToolSheetTarget
import io.rivethub.app.plane.resolveToolSheet
import io.rivethub.app.plane.toolSheetTarget
import io.rivethub.app.plane.isStripError
import io.rivethub.app.plane.loadingLabel
import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.plane.statsLineOrNull
import io.rivethub.app.plane.toolArgStrings
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.plane.statsLineVisible
import io.rivethub.app.plane.MessageAction
import io.rivethub.app.plane.actionRowShown
import io.rivethub.app.plane.messageActions
import io.rivethub.app.plane.regenerateSource
import io.rivethub.app.plane.splitAttachedLines
import io.rivethub.app.plane.userActionText
import io.rivethub.app.plane.jumpTargets
import io.rivethub.app.plane.jumperHideDelayMs
import io.rivethub.app.plane.jumperVisible
import io.rivethub.app.ui.components.AttachmentImageSource
import io.rivethub.app.ui.components.MessageActionRow
import io.rivethub.app.ui.components.MessageActionsState
import io.rivethub.app.ui.components.MessageJumper
import io.rivethub.app.ui.components.MessageMoreSheet
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.SelectCopySheet
import io.rivethub.app.ui.components.shareMessageText
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.components.RenameSheet
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.AgentStatusLine
import io.rivethub.app.ui.components.ApprovalCard
import io.rivethub.app.ui.components.AskUserCardView
import io.rivethub.app.ui.components.ChatSessionHeader
import io.rivethub.app.ui.components.ChatStatusStrip
import io.rivethub.app.ui.components.TerminalHeader
import io.rivethub.app.ui.components.Composer
import io.rivethub.app.ui.components.QueuedStrip
import io.rivethub.app.ui.components.ComposerModelPicker
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.ComposerPicker
import io.rivethub.app.ui.components.Lucide
import io.rivethub.app.ui.components.NativeTurnControls
import io.rivethub.app.ui.components.ModePager
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.components.TerminalRetryState
import io.rivethub.app.ui.components.ChatErrorStack
import io.rivethub.app.ui.components.ToolDetailSheet
import io.rivethub.app.ui.components.ToolRow
import io.rivethub.app.ui.components.TranscriptAssistantTurn
import io.rivethub.app.ui.components.TranscriptUserTurn
import io.rivethub.app.ui.components.rememberComposerMediaLaunchers
import io.rivethub.app.ui.components.rivetHexColor
import io.rivethub.app.ui.term.TermEndedBar
import io.rivethub.app.ui.term.TerminalKeyBar
import io.rivethub.app.ui.term.TerminalPane
import io.rivethub.app.ui.term.clipboardText
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

/**
 * The session screen. There is NO wordmark TopBar here (web
 * lib/session-header.ts: the bar shows on every narrow screen EXCEPT an open
 * session). Chat mode has no back control (Phil 2026-09-03: "back" is the
 * right-side history drawer). Terminal mode swaps in [TerminalHeader]: back
 * returns to Chat and resyncs the transcript. The header owns the status-bar
 * inset; [onOpenDrawer] opens the left navigation drawer, [onOpenHistory] the
 * right history drawer.
 */
@Composable
fun HarnessChatScreen(
    vm: HarnessChatViewModel,
    tasksVm: io.rivethub.app.ui.TasksViewModel,
    onTaskCreated: (String) -> Unit,
    onOpenDrawer: () -> Unit,
    onOpenHistory: () -> Unit,
    hubVm: HubViewModel,
    harnessId: String?,
    initialAgentId: String?,
    onNewChat: (String?) -> Unit,
    shareUris: List<android.net.Uri> = emptyList(),
    onShareConsumed: () -> Unit = {},
) {
    val st by vm.state.collectAsState()
    val hubState by hubVm.state.collectAsState()
    val agentId = hubVm.agentForSession(st.sessionId) ?: initialAgentId?.takeIf { it.isNotBlank() }
    val agent = hubState.agents.find { it.agentId == agentId }
    var renameOpen by remember(st.sessionId) { mutableStateOf(false) }
    var renameNotice by remember(st.sessionId) { mutableStateOf(0) }
    var searchActive by remember(st.sessionId) { mutableStateOf(false) }
    var query by remember(st.sessionId) { mutableStateOf("") }
    var jumpToTurn by remember(st.sessionId) { mutableStateOf<Int?>(null) }
    val listState = rememberLazyListState()
    val transcriptPin = remember(st.sessionId) { TranscriptPin() }
    val searchFocus = remember { FocusRequester() }
    LaunchedEffect(renameNotice) {
        if (renameNotice > 0) {
            delay(2_000)
            renameNotice = 0
        }
    }
    var delegateGoal by remember { mutableStateOf<String?>(null) }
    delegateGoal?.let { goal ->
        io.rivethub.app.ui.components.DelegateSheet(
            vm = tasksVm, initialGoal = goal,
            onDismiss = { delegateGoal = null },
            onCreated = { id ->
                vm.clearComposer()
                delegateGoal = null
                onTaskCreated(id)
            },
        )
    }
    val ctx = LocalContext.current
    val chatLabel = stringResource(R.string.mode_chat)
    val termLabel = stringResource(R.string.mode_terminal)
    val pages = listOf(termLabel, chatLabel)
    val selected = if (st.mode == SessionMode.Terminal) termLabel else chatLabel
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.onAppBackground() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { vm.onAppForeground() }
    BackHandler(enabled = st.mode == SessionMode.Terminal) {
        vm.setMode(SessionMode.Chat)
    }
    LaunchedEffect(st.mode) {
        if (st.mode == SessionMode.Terminal) vm.ensureTerminal()
    }
    LaunchedEffect(st.termClipboard) {
        val clip = st.termClipboard ?: return@LaunchedEffect
        copyText(ctx, clip, sensitive = true)
        vm.consumeTermClipboard()
    }
    fun stageFromUri(uri: android.net.Uri) {
        var name = uri.lastPathSegment ?: "file"
        var mime: String? = ctx.contentResolver.getType(uri)
        var size = -1L
        ctx.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cur ->
            if (cur.moveToFirst()) {
                val ni = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val si = cur.getColumnIndex(OpenableColumns.SIZE)
                if (ni >= 0) name = cur.getString(ni) ?: name
                if (si >= 0 && !cur.isNull(si)) size = cur.getLong(si)
            }
        }
        vm.stageUri(uri, name, mime, size)
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        stageFromUri(uri)
    }
    val media = rememberComposerMediaLaunchers(
        onPhoto = { stageFromUri(it) },
        onCamera = { uri, file -> vm.stageCapture(uri, file) },
        onCaptureStart = { vm.captureStarted(it) },
        onCaptureAbandoned = { vm.captureAbandoned(it) },
    )
    LaunchedEffect(shareUris) {
        if (shareUris.isEmpty()) return@LaunchedEffect
        shareUris.forEach { stageFromUri(it) }
        onShareConsumed()
    }

    val composerEnabled = composerIsEnabled(st.ws, st.error)
    val connected = st.ws == WsStatus.OPEN
    val sendEnabled = composerCanSend(
        st.ws,
        st.composer,
        st.attachments.any { it.status == AttachmentStatus.READY },
    )
    val sessionLabel = if (st.draft) stringResource(R.string.new_conversation) else st.sessionId
    val reported = st.turns.mapNotNull { it.usage?.promptTokens }.lastOrNull()
    val barModel = st.turns.mapNotNull { it.model }.lastOrNull() ?: st.model
    val context = remember(st.turns, st.model, st.contextWindow, st.compactAt) {
        contextBarView(
            reported,
            barModel,
            st.turns.map { it.text },
            contextWindow = st.contextWindow,
            compactAt = st.compactAt,
        )
    }
    val sessionItem = remember(hubState.items, st.sessionId) {
        findChatItem(hubState.items.map { it.item }, st.sessionId)
    }
    val nativeModels = remember(vm, st.sheet, st.transport) { vm.nativeModels() }
    val displayTitle = sessionItem?.let { displayTitle(it, hubState.titleOverrides) }
        ?: hubState.titleOverrides[st.sessionId] ?: st.title
    val headerContext = context.takeIf { st.turns.any { it.role == "assistant" && it.complete != false } }
    val block = titleBlock(
        title = displayTitle,
        draft = st.draft,
        agentName = agent?.name,
        modelLabel = st.sheet?.models?.find { it.id == st.model }?.label?.takeIf { it.isNotBlank() }
            ?: nativeModels.find { it.first == st.model }?.second?.takeIf { it.isNotBlank() },
        harnessLabel = harnessLabel(harnessId ?: agent?.harnessId),
        context = headerContext,
        newChatLabel = stringResource(R.string.new_chat),
    )
    if (renameOpen && renameAllowed(st.draft, st.turns.size)) {
        RenameSheet(
            initial = displayTitle,
            onDismiss = { renameOpen = false },
            onSave = { text ->
                hubVm.rename(st.sessionId, text)
                renameOpen = false
            },
        )
    }
    val accentHex = accentFor(
        command = st.sessionId.substringBefore(':').takeIf { st.sessionId.contains(':') } ?: st.model,
    )
    val accent = rivetHexColor(accentHex)
    // The strip is only for the five composer/attachment codes; every free-text
    // error (transport, turn, terminal attach) is a card in the stack.
    val stripError = when (st.errorCode?.takeIf { isStripError(it) }) {
        HarnessChatViewModel.ERR_UPLOADING -> stringResource(R.string.error_upload_in_progress)
        HarnessChatViewModel.ERR_TOO_LARGE -> stringResource(R.string.error_upload_too_large)
        HarnessChatViewModel.ERR_FAILED_ATTACHMENT -> stringResource(R.string.error_failed_attachment)
        HarnessChatViewModel.ERR_IMAGE_ONLY -> stringResource(R.string.error_image_only)
        HarnessChatViewModel.ERR_IMAGE_UNSUPPORTED -> stringResource(R.string.error_image_unsupported)
        HarnessChatViewModel.ERR_COMPACT_BUSY -> stringResource(R.string.error_compact_busy)
        else -> st.error
    }
    val nativeImages = vm.nativeImagesEnabled()
    val reconnecting = stringResource(R.string.ws_reconnecting_ellipsis)

    val showStop = st.inFlight && st.gate.canInterrupt && !st.draft
    val termRemoteError = st.termStatus == TermStatus.Closed && st.termRemote && !st.termError.isNullOrBlank()
    if (st.spawnConflict == SpawnConflict.RecordedDir) {
        RivetConfirmDialog(
            title = stringResource(R.string.spawn_conflict_title),
            message = stringResource(R.string.spawn_conflict_recorded_dir),
            confirmLabel = stringResource(R.string.spawn_conflict_resume_anyway),
            onConfirm = vm::resumeHereAnyway,
            onDismiss = vm::dismissSpawnConflict,
        )
    }

    Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        if (st.mode == SessionMode.Terminal) {
            TerminalHeader(
                title = terminalTitle(
                    modelLabel = modelDisplayLabel(st.sheet, st.model),
                    harnessLabel = vm.harnessDisplayLabel(),
                    conversationTitle = st.title,
                    // AnsiScreen does not surface an OSC window title.
                    programTitle = null,
                    status = st.termStatus,
                    remote = st.termRemote,
                    untitled = stringResource(R.string.term_untitled),
                ),
                onBack = { vm.setMode(SessionMode.Chat) },
                onStop = if (showStop) vm::stop else null,
            )
        } else {
        ChatSessionHeader(
            sessionLabel = sessionLabel,
            context = if (st.mode == SessionMode.Chat) headerContext else context,
            mode = st.mode,
            titleBlock = block,
            searchActive = searchActive,
            onRenameTap = {
                if (renameAllowed(st.draft, st.turns.size)) renameOpen = true else renameNotice++
            },
            onMode = vm::setMode,
            onSearch = {
                query = ""
                searchActive = !searchActive
            },
            onNewChat = { onNewChat(agentId) },
            modeOptions = pages,
            selectedMode = selected,
            onSelectMode = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            onOpenMenu = onOpenDrawer,
            onOpenHistory = onOpenHistory,
            showStop = showStop,
            onStop = vm::stop,
        )
        }
        if (searchActive && st.mode == SessionMode.Chat) {
            RivetField(
                value = query,
                onValueChange = { query = it },
                placeholder = stringResource(R.string.search_messages_hint),
                size = RivetFieldSize.Filter,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp).focusRequester(searchFocus),
            )
            LaunchedEffect(Unit) { searchFocus.requestFocus() }
        }
        if (renameNotice > 0) {
            ChatStatusStrip(
                stringResource(R.string.rename_needs_turns),
                error = false,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        if (st.ws == WsStatus.CONNECTING) {
            ChatStatusStrip(reconnecting, error = false)
        } else if (st.ws == WsStatus.CLOSED) {
            ChatStatusStrip(stringResource(R.string.ws_disconnected), error = true)
        }
        stripError?.let { ChatStatusStrip("✗ $it", error = true) }
        // Horizontal swipes belong to the drawers, so the pager never swipes.
        // Chat switches with the header segment; Terminal uses the back arrow.
        ModePager(
            pages = pages,
            selected = selected,
            onSelect = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            swipe = false,
            showControl = false,
            modifier = Modifier.weight(1f),
        ) { page ->
            if (page == termLabel) {
                TerminalPane(
                    screen = vm.terminalScreen(),
                    rev = st.termRev,
                    fontSp = st.termFontSp,
                    status = st.termStatus,
                    onResize = vm::resizeTerminal,
                    onBytes = vm::sendTermBytes,
                    onBytesRaw = vm::sendTermBytesRaw,
                    ctrl = st.termCtrl,
                    owner = st.termOwner,
                    onClaim = vm::claimTerminal,
                    error = st.termError,
                    remote = st.termRemote,
                    onRestart = vm::restartTerminal,
                    onBackToChat = { vm.setMode(SessionMode.Chat) },
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                if (searchActive) {
                    val hits = remember(st.turns, query) { searchTurns(st.turns, query) }
                    MessageSearchResults(query, hits) { hit ->
                        jumpToTurn = hit.turnIndex
                        searchActive = false
                        query = ""
                    }
                } else {
                    ChatTranscript(vm, accent, listState, transcriptPin, jumpToTurn) { jumpToTurn = null }
                }
            }
        }
        if (st.mode == SessionMode.Terminal) {
            when {
                st.termStatus == TermStatus.Exited -> TermEndedBar(
                    onRestart = vm::restartTerminal,
                    onBackToChat = { vm.setMode(SessionMode.Chat) },
                )
                termRemoteError -> Unit
                else -> TerminalKeyBar(
                    ctrl = st.termCtrl,
                    alt = st.termAlt,
                    onCtrl = vm::toggleTermCtrl,
                    onCtrlLock = vm::lockTermCtrl,
                    onAlt = vm::toggleTermAlt,
                    onBytes = vm::sendTermBytes,
                    onPaste = {
                        val text = clipboardText(ctx) ?: return@TerminalKeyBar
                        vm.sendTermText(text)
                    },
                    applicationCursor = vm.terminalScreen().applicationCursor,
                    attachCommand = st.attachCommand,
                    onOpenInTerminal = {
                        val cmd = st.attachCommand ?: return@TerminalKeyBar
                        copyText(ctx, cmd)
                    },
                    onDetach = vm::userDetachTerminal,
                    modifier = Modifier.navigationBarsPadding(),
                )
            }
        } else {
            ChatErrorStack(
                errors = st.errors,
                onDismiss = vm::dismissError,
                onClearAll = vm::clearErrors,
            )
            QueuedStrip(
                items = st.queued,
                onInject = vm::injectQueued,
                onCancel = vm::cancelQueued,
            )
            if (nativeModels.isNotEmpty()) {
                NativeTurnControls(
                    models = nativeModels.map { SelectOption(it.first, it.second) },
                    model = st.model,
                    onModel = vm::setModel,
                    efforts = vm.effortOptions().map { SelectOption(it.first, it.second) },
                    effort = st.effort,
                    onEffort = vm::setEffort,
                    enabled = composerEnabled,
                )
            }
            Composer(
                value = st.composer,
                onValueChange = vm::setComposer,
                placeholder = if (connected) {
                    stringResource(R.string.composer_placeholder)
                } else {
                    stringResource(R.string.composer_reconnecting)
                },
                connected = connected,
                sending = st.inFlight,
                sendEnabled = sendEnabled,
                canStop = st.gate.canInterrupt,
                onAttach = { pick.launch(if (nativeImages) arrayOf("image/*") else arrayOf("*/*")) },
                onSend = vm::send,
                onStop = vm::stop,
                onDelegate = { delegateGoal = io.rivethub.app.plane.delegateGoalFromComposer(st.composer) },
                enabled = composerEnabled,
                editing = st.editing != null,
                onCancelEdit = vm::cancelEdit,
                onSendLongPress = vm::enqueueSend,
                plusItems = vm.plusItems(),
                onPlusItem = { item ->
                    when (item) {
                        PlusItem.Photo -> media.pickPhoto()
                        PlusItem.Camera -> media.takePhoto()
                        PlusItem.File -> pick.launch(if (nativeImages) arrayOf("image/*") else arrayOf("*/*"))
                        PlusItem.Compress -> vm.compactContext()
                    }
                },
                ask = {
                    when {
                        st.ask != null -> AskUserCardView(
                            card = st.ask!!,
                            onSubmit = { picked, free -> vm.answerAsk(picked, free) },
                            onDismiss = vm::dismissAsk,
                            enabled = !st.answeringPrompt,
                            error = st.askError,
                            promptId = st.promptId,
                        )
                        st.approval != null -> ApprovalCard(
                            approval = st.approval!!,
                            onDecide = vm::decideApproval,
                        )
                    }
                },
                attachments = st.attachments,
                onRemoveAttachment = vm::removeAttachment,
                modifier = Modifier.navigationBarsPadding(),
                pickers = { compact ->
                    ComposerPicker(
                        icon = R.drawable.lucide_server,
                        label = st.nodeName,
                        compact = compact,
                        options = listOf(SelectOption(st.nodeDenUrl, st.nodeName)),
                        value = st.nodeDenUrl,
                        onChange = {},
                        title = stringResource(R.string.node_picker),
                    )
                    if (nativeModels.isEmpty()) {
                        val models = st.sheet?.models.orEmpty()
                        if (models.isNotEmpty()) {
                            val modelLabel = models.find { it.id == st.model }?.label ?: st.model
                            ComposerModelPicker(
                                label = modelLabel.ifBlank { stringResource(R.string.model_picker) },
                                compact = compact,
                                models = models,
                                favourites = st.favouriteModels,
                                value = st.model,
                                onPick = vm::setModel,
                                onToggleFavourite = vm::toggleFavouriteModel,
                                title = stringResource(R.string.model_picker),
                            )
                        }
                        val efforts = vm.effortOptions().map { SelectOption(it.first, it.second) }
                        if (efforts.isNotEmpty()) {
                            val effortLabel = efforts.find { it.value == st.effort }?.label ?: st.effort
                            ComposerPicker(
                                icon = R.drawable.lucide_lightbulb,
                                label = effortLabel.ifBlank { stringResource(R.string.effort_picker) },
                                compact = compact,
                                options = efforts,
                                value = st.effort,
                                onChange = vm::setEffort,
                                title = stringResource(R.string.effort_picker),
                            )
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun ChatTranscript(
    vm: HarnessChatViewModel,
    accent: androidx.compose.ui.graphics.Color,
    list: LazyListState,
    pin: TranscriptPin,
    jumpToTurn: Int?,
    onJumpConsumed: () -> Unit,
) {
    val st by vm.state.collectAsState()
    val ctx = LocalContext.current
    val colors = RivetTheme.colors
    val scope = rememberCoroutineScope()
    val liveExtra = if (st.inFlight || st.liveText.isNotBlank() || st.liveReasoning.isNotBlank()) 1 else 0
    val count = st.turns.size + liveExtra
    // Chain-of-thought steps for the in-flight turn; stored turns build theirs per item.
    // Tool steps rebuild only when the tools change (results are pre-rendered,
    // bounded previews), not on every reasoning delta.
    val liveToolSteps = remember(st.liveTools) {
        cotSteps(null, "", st.liveTools, null, live = true).filterIsInstance<CotStep.Tool>()
    }
    val liveReasoningMs = st.reasoning?.let { span -> span.endMs?.let { it - span.startMs } }
    val liveSteps = remember(st.liveReasoning, liveReasoningMs, liveToolSteps) {
        val head = cotSteps(null, st.liveReasoning, emptyList(), liveReasoningMs, live = true)
        head + liveToolSteps
    }
    // Open tool sheet, held by identity (plane/ToolSheet.kt): a live result
    // lands while it is open, the call follows its turn onto the committed
    // transcript, and it never switches to another turn's call.
    var detail by remember { mutableStateOf<ToolSheetTarget?>(null) }
    detail?.let { key ->
        val resolved = remember(key, st.liveTurn, liveToolSteps, st.turns) {
            resolveToolSheet(key, st.liveTurn, liveToolSteps, st.turns) { i ->
                storedCotSteps(st.turns[i], null).filterIsInstance<CotStep.Tool>()
            }
        }
        SideEffect { if (detail == key && resolved != key) detail = resolved }
        ToolDetailSheet(resolved.shown, onDismiss = { detail = null })
    }
    // Message actions (UX-SPEC §1.3): screen-local reveal / More / Select & copy
    // / Regenerate-confirm state; the VM only sees regenerate and edit.
    val actionsUi = remember { MessageActionsState() }
    val attachmentImages = remember(vm) { AttachmentImageSource(vm.attachmentNamespace, vm::attachmentBytes) }
    fun onMessageAction(index: Int, action: MessageAction, text: String) {
        when (action) {
            MessageAction.Copy -> copyText(ctx, text)
            MessageAction.Regenerate -> actionsUi.confirmRegenerate = index
            MessageAction.SelectCopy -> actionsUi.selectText = text
            MessageAction.Edit -> vm.editFromTurn(index)
            MessageAction.Share -> shareMessageText(ctx, text)
        }
    }
    actionsUi.moreFor?.let { index ->
        val turn = st.turns.getOrNull(index)
        if (turn == null) {
            SideEffect { actionsUi.moreFor = null }
        } else {
            val text = messageBody(turn)
            MessageMoreSheet(
                actions = messageActions(
                    turn.role,
                    st.inFlight,
                    regenerateSource(st.turns, index) != null,
                    hasBody = messageHasBody(turn),
                ),
                onAction = { onMessageAction(index, it, text) },
                onDismiss = { actionsUi.moreFor = null },
            )
        }
    }
    actionsUi.selectText?.let { text ->
        SelectCopySheet(text, onDismiss = { actionsUi.selectText = null })
    }
    actionsUi.confirmRegenerate?.let { index ->
        RivetConfirmDialog(
            title = stringResource(R.string.regenerate),
            message = stringResource(R.string.regenerate_confirm),
            confirmLabel = stringResource(R.string.regenerate),
            cancelLabel = stringResource(R.string.action_cancel),
            onConfirm = {
                actionsUi.confirmRegenerate = null
                actionsUi.revealed = null
                vm.regenerate(index)
            },
            onDismiss = { actionsUi.confirmRegenerate = null },
        )
    }
    // transcript.tsx:385-480 port (plane/TranscriptPin.kt): pinned starts
    // true; the first non-empty load jumps to the end unconditionally (a chat
    // opens at the bottom of the thread); afterwards new content follows ONLY
    // while within 120dp of the bottom; the ↓ latest pill re-pins.
    var pinned by remember(pin) { mutableStateOf(pin.pinned) }
    val density = LocalDensity.current
    val distanceFromBottom by remember {
        derivedStateOf {
            val info = list.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()
            when {
                info.totalItemsCount == 0 || lastVisible == null -> 0f
                lastVisible.index < info.totalItemsCount - 1 -> Float.POSITIVE_INFINITY
                else -> (lastVisible.offset + lastVisible.size - info.viewportEndOffset).toFloat()
            }
        }
    }
    LaunchedEffect(pin, jumpToTurn) {
        snapshotFlow { distanceFromBottom }.collect { d ->
            if (jumpToTurn == null) pin.onScroll(with(density) { d.toDp().value })
            pinned = pin.pinned
        }
    }
    LaunchedEffect(jumpToTurn) {
        if (jumpToTurn != null) {
            // Stored turns start at item zero; live output and the spacer follow them.
            pin.onContent(count)
            pin.onScroll(Float.POSITIVE_INFINITY)
            pinned = false
            list.animateScrollToItem(jumpToTurn)
            onJumpConsumed()
        }
    }
    LaunchedEffect(count, st.liveText.length, st.liveReasoning.length, st.liveTools.size, jumpToTurn) {
        if (jumpToTurn == null && pin.onContent(count)) {
            // Index `count` = the trailing spacer — scrolling it into view
            // lands on the very bottom of the thread.
            runCatching { list.scrollToItem(count) }
        }
        pinned = pin.pinned
    }
    // Message jumper (UX-SPEC §1.2): shown while the user drags/flings and for
    // JUMPER_VISIBLE_MS after it goes idle, hidden while pinned. The hide is a
    // one-shot delay keyed on the last scroll time — not a poll.
    var userScrolling by remember { mutableStateOf(false) }
    var lastIdleMs by remember { mutableLongStateOf(0L) }
    var jumperShown by remember { mutableStateOf(false) }
    LaunchedEffect(list) {
        list.interactionSource.interactions.collect { ia ->
            when (ia) {
                is DragInteraction.Start -> userScrolling = true
                is DragInteraction.Stop, is DragInteraction.Cancel -> if (!list.isScrollInProgress && userScrolling) {
                    userScrolling = false
                    lastIdleMs = System.currentTimeMillis()
                }
            }
        }
    }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress }.collect { scrolling ->
            if (!scrolling && userScrolling) {
                userScrolling = false
                lastIdleMs = System.currentTimeMillis()
            }
        }
    }
    LaunchedEffect(userScrolling, lastIdleMs) {
        val now = System.currentTimeMillis()
        val scrolled = userScrolling || lastIdleMs > 0L
        jumperShown = jumperVisible(scrolled, if (userScrolling) now else lastIdleMs, now)
        if (jumperShown && !userScrolling) {
            delay(jumperHideDelayMs(lastIdleMs, now))
            jumperShown = jumperVisible(scrolled, lastIdleMs, System.currentTimeMillis())
        }
    }
    val userStops = remember(st.turns) { st.turns.indices.filter { st.turns[it].role == "user" } }
    val targets by remember(userStops) {
        derivedStateOf {
            val info = list.layoutInfo
            jumpTargets(
                firstVisible = list.firstVisibleItemIndex,
                lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: 0,
                count = info.totalItemsCount,
                stops = userStops,
            )
        }
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
        itemsIndexed(st.turns, key = { i, turn -> "$i:${turn.role}" }) { i, turn ->
            if (turn.role == "user") {
                val (body, refs) = remember(turn.text) { splitAttachedLines(turn.text) }
                val hasBody = body.isNotBlank()
                val actions = messageActions("user", st.inFlight, hasPrecedingUser = false, hasBody = hasBody)
                TranscriptUserTurn(
                    text = body,
                    time = null,
                    onCopy = { copyText(ctx, it) },
                    attachments = refs,
                    images = attachmentImages,
                    onTap = { if (hasBody) vm.editFromTurn(i) },
                    onLongPress = { actionsUi.toggle(i) },
                    actionRow = if (actionRowShown(st.actionRowAlways, actionsUi.revealed == i, actions)) {
                        {
                            MessageActionRow(
                                actions = actions,
                                onAction = { onMessageAction(i, it, userActionText(body, refs)) },
                                onMore = { actionsUi.moreFor = i },
                            )
                        }
                    } else {
                        null
                    },
                )
            } else {
                val body = remember(turn.text) { splitHermesReasoning(turn.text).text }
                val durationMs = st.reasoningDurations[i]
                val steps = remember(turn, durationMs) { storedCotSteps(turn, durationMs) }
                val expanded = i in st.cotExpanded
                val fold = remember(steps, expanded) { foldSteps(steps, expanded) }
                val actions = if (st.actionRowAlways || actionsUi.revealed == i) {
                    messageActions(
                        turn.role,
                        st.inFlight,
                        hasPrecedingUser = regenerateSource(st.turns, i) != null,
                        hasBody = body.isNotBlank(),
                    )
                } else {
                    emptyList()
                }
                TranscriptAssistantTurn(
                    codeLineNumbers = st.codeLineNumbers,
                    codeWrap = st.codeWrap,
                    text = body,
                    model = turn.model,
                    time = null,
                    accent = accent,
                    steps = steps,
                    fold = fold,
                    expanded = expanded,
                    onToggleFold = { vm.toggleCot(i) },
                    onToolTap = { tool -> detail = toolSheetTarget(i, st.liveTurn, steps, tool) },
                    stats = if (statsLineVisible(st.showStats, turn.usage)) statsLineOrNull(turn.usage) else null,
                    onCopy = { copyText(ctx, it) },
                    onTap = { actionsUi.toggle(i) },
                    // A completed tool-only turn (blank body) still gets a row when
                    // the "always" setting is on: Regenerate only (plane/MessageActions.kt).
                    actionRow = if (actionRowShown(st.actionRowAlways, actionsUi.revealed == i, actions)) {
                        {
                            MessageActionRow(
                                actions = actions,
                                onAction = { onMessageAction(i, it, body) },
                                onMore = { actionsUi.moreFor = i },
                            )
                        }
                    } else {
                        null
                    },
                )
            }
        }
        if (st.inFlight || st.liveText.isNotBlank() || st.liveReasoning.isNotBlank() || st.liveTools.isNotEmpty()) {
            item {
                val expanded = LIVE_TURN in st.cotExpanded
                val fold = remember(liveSteps, expanded) { foldSteps(liveSteps, expanded) }
                TranscriptAssistantTurn(
                    codeLineNumbers = st.codeLineNumbers,
                    codeWrap = st.codeWrap,
                    text = splitHermesReasoning(st.liveText).text,
                    model = st.model.takeIf { it.isNotBlank() },
                    time = null,
                    accent = accent,
                    steps = liveSteps,
                    fold = fold,
                    expanded = expanded,
                    onToggleFold = { vm.toggleCot(LIVE_TURN) },
                    onToolTap = { tool -> detail = toolSheetTarget(LIVE_TURN, st.liveTurn, liveSteps, tool) },
                    stats = null,
                    onCopy = { copyText(ctx, it) },
                    liveSpan = st.reasoning,
                    nowMs = vm.clockMs,
                )
                if (st.inFlight) {
                    AgentStatusLine(loadingLabel(liveSteps, st.agentStatusText) ?: stringResource(R.string.working))
                }
            }
        }
            item { Spacer(Modifier.height(Dimens.grid2)) }
        }
        if (jumperShown && !pinned) {
            MessageJumper(
                targets = targets,
                onJump = { index ->
                    lastIdleMs = System.currentTimeMillis()
                    scope.launch { runCatching { list.animateScrollToItem(index) } }
                },
                onBottom = {
                    pin.jump()
                    pinned = true
                    scope.launch { runCatching { list.scrollToItem(count) } }
                },
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 8.dp),
            )
        }
        if (!pinned) {
            // transcript.tsx:470-479 — the jump pill: absolute bottom-center
            // 16dp, `gap-1.5 rounded-full border border-em-dim/50 bg-panel
            // px-3 py-1.5 font-mono text-[11px] text-em`, ArrowDown 14dp
            // (`size-3.5`), label "latest" (lowercase, as on the web).
            Row(
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 16.dp)
                    .clip(RoundedCornerShape(Radius.full))
                    .border(1.dp, colors.emDim.copy(alpha = 0.5f), RoundedCornerShape(Radius.full))
                    .background(colors.panel)
                    .clickable(role = Role.Button) {
                        pin.jump()
                        pinned = true
                        scope.launch { runCatching { list.scrollToItem(count) } }
                    }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Lucide(
                    R.drawable.lucide_arrow_down,
                    contentDescription = null,
                    tint = colors.em,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    stringResource(R.string.jump_latest),
                    color = colors.em,
                    style = RivetType.mono11,
                )
            }
        }
    }
}

@Composable
private fun MessageSearchResults(query: String, hits: List<SearchHit>, onHit: (SearchHit) -> Unit) {
    val colors = RivetTheme.colors
    if (query.isBlank()) {
        EmptyLine(stringResource(R.string.search_type_to_find))
        return
    }
    if (hits.isEmpty()) {
        EmptyLine(stringResource(R.string.search_no_matches))
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(hits, key = { it.turnIndex }) { hit ->
            val snippet = buildAnnotatedString {
                append(hit.snippet.replace('\n', ' ').replace('\r', ' '))
                val range = highlightRanges(hit)
                addStyle(SpanStyle(color = colors.em, fontWeight = FontWeight.Bold), range.first, range.last + 1)
            }
            Text(
                snippet,
                color = colors.ink,
                style = RivetType.sm,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(Radius.sm))
                    .clickable(role = Role.Button) { onHit(hit) }
                    .padding(horizontal = 12.dp, vertical = 14.dp),
            )
        }
    }
}

@Composable
private fun EmptyLine(text: String) {
    Text(
        text,
        color = RivetTheme.colors.inkDim,
        style = RivetType.xs,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

/** The text a message action works on: user body without attachment lines, assistant text without Hermes reasoning. */
/** The text Copy / Select & copy / Share act on (attachment names for an attachment-only user turn). */
private fun messageBody(turn: HarnessTranscriptTurn): String =
    if (turn.role == "user") {
        splitAttachedLines(turn.text).let { (body, refs) -> userActionText(body, refs) }
    } else {
        splitHermesReasoning(turn.text).text
    }

/** Whether the turn has text of its own (not only attachments / tool calls). */
private fun messageHasBody(turn: HarnessTranscriptTurn): Boolean =
    if (turn.role == "user") {
        splitAttachedLines(turn.text).first.isNotBlank()
    } else {
        splitHermesReasoning(turn.text).text.isNotBlank()
    }

/** Timeline key of the in-flight turn (stored turns use their index). */
private const val LIVE_TURN = LIVE_TURN_INDEX

/** Stored-turn steps; Hermes keeps its reasoning inside the text, so fold that in as `thinking`. */
private fun storedCotSteps(turn: HarnessTranscriptTurn, durationMs: Long?): List<CotStep> {
    val thinking = turn.thinking?.takeIf { it.isNotBlank() } ?: splitHermesReasoning(turn.text).reasoning
    return cotSteps(
        turn = turn.copy(thinking = thinking.takeIf { it.isNotBlank() }),
        liveReasoning = "",
        liveTools = emptyList(),
        reasoningDurationMs = durationMs,
        live = false,
    )
}
