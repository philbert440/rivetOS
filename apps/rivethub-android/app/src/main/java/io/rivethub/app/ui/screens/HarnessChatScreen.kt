package io.rivethub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.rivethub.app.R
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.TranscriptPin
import io.rivethub.app.plane.accentFor
import io.rivethub.app.plane.composerCanSend
import io.rivethub.app.plane.composerIsEnabled
import io.rivethub.app.plane.contextBarView
import io.rivethub.app.plane.humanToolTitle
import io.rivethub.app.plane.statsLineOrNull
import io.rivethub.app.plane.toolArgStrings
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.components.AskUserCardView
import io.rivethub.app.ui.components.ChatSessionHeader
import io.rivethub.app.ui.components.ChatStatusStrip
import io.rivethub.app.ui.components.Composer
import io.rivethub.app.ui.components.ComposerPicker
import io.rivethub.app.ui.components.Lucide
import io.rivethub.app.ui.components.ModePager
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.components.TerminalRetryState
import io.rivethub.app.ui.components.ToolRow
import io.rivethub.app.ui.components.TranscriptAssistantTurn
import io.rivethub.app.ui.components.TranscriptUserTurn
import io.rivethub.app.ui.components.rivetHexColor
import io.rivethub.app.ui.term.TerminalKeyBar
import io.rivethub.app.ui.term.TerminalPane
import io.rivethub.app.ui.term.clipboardText
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.launch

/**
 * The session screen. There is NO wordmark TopBar here (web
 * lib/session-header.ts: the bar shows on every narrow screen EXCEPT an open
 * session) and no back control (Phil 2026-09-03: "back" is the right-side
 * history drawer). The one-row [ChatSessionHeader] owns the status-bar inset;
 * [onOpenDrawer] opens the left navigation drawer (☰), [onOpenHistory] the
 * right history drawer.
 */
@Composable
fun HarnessChatScreen(
    vm: HarnessChatViewModel,
    onOpenDrawer: () -> Unit,
    onOpenHistory: () -> Unit,
) {
    val st by vm.state.collectAsState()
    val ctx = LocalContext.current
    val chatLabel = stringResource(R.string.mode_chat)
    val termLabel = stringResource(R.string.mode_terminal)
    val pages = listOf(termLabel, chatLabel)
    val selected = if (st.mode == SessionMode.Terminal) termLabel else chatLabel
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.onAppBackground() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { vm.onAppForeground() }
    LaunchedEffect(st.mode) {
        if (st.mode == SessionMode.Terminal) vm.ensureTerminal()
    }
    LaunchedEffect(st.termClipboard) {
        val clip = st.termClipboard ?: return@LaunchedEffect
        copyText(ctx, clip, sensitive = true)
        vm.consumeTermClipboard()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
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
    val context = remember(st.turns, st.model) {
        contextBarView(reported, barModel, st.turns.map { it.text })
    }
    val accentHex = accentFor(
        command = st.sessionId.substringBefore(':').takeIf { st.sessionId.contains(':') } ?: st.model,
    )
    val accent = rivetHexColor(accentHex)
    val stripError = when (st.errorCode) {
        HarnessChatViewModel.ERR_UPLOADING -> stringResource(R.string.error_upload_in_progress)
        HarnessChatViewModel.ERR_TOO_LARGE -> stringResource(R.string.error_upload_too_large)
        else -> st.error
    }
    val reconnecting = stringResource(R.string.ws_reconnecting_ellipsis)

    Column(
        Modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        ChatSessionHeader(
            sessionLabel = sessionLabel,
            context = context,
            modeOptions = pages,
            selectedMode = selected,
            onSelectMode = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            onOpenMenu = onOpenDrawer,
            onOpenHistory = onOpenHistory,
            showStop = st.inFlight && st.gate.canInterrupt && !st.draft,
            onStop = vm::stop,
        )
        if (st.ws == WsStatus.CONNECTING) {
            ChatStatusStrip(reconnecting, error = false)
        } else if (st.ws == WsStatus.CLOSED) {
            ChatStatusStrip(stringResource(R.string.ws_disconnected), error = true)
        }
        stripError?.let { ChatStatusStrip("✗ $it", error = true) }
        // Phil 2026-09-03: the Terminal|Chat segment is the ONLY mode switch —
        // horizontal swipes belong to the drawers, so the pager never swipes.
        ModePager(
            pages = pages,
            selected = selected,
            onSelect = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            swipe = false,
            showControl = false,
            modifier = Modifier.weight(1f),
        ) { page ->
            if (page == termLabel) {
                if (st.termStatus == TermStatus.Exited) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        TerminalRetryState(st.error ?: stringResource(R.string.term_status_exited))
                    }
                } else {
                    TerminalPane(
                        screen = vm.terminalScreen(),
                        rev = st.termRev,
                        fontSp = st.termFontSp,
                        status = st.termStatus,
                        onResize = vm::resizeTerminal,
                        onBytes = vm::sendTermBytes,
                        ctrl = st.termCtrl,
                        owner = st.termOwner,
                        onClaim = vm::claimTerminal,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            } else {
                ChatTranscript(vm, accent)
            }
        }
        if (st.mode == SessionMode.Terminal) {
            TerminalKeyBar(
                ctrl = st.termCtrl,
                onCtrl = vm::toggleTermCtrl,
                onCtrlLock = vm::lockTermCtrl,
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
        } else {
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
                onAttach = { pick.launch(arrayOf("*/*")) },
                onSend = vm::send,
                onStop = vm::stop,
                enabled = composerEnabled,
                ask = {
                    st.ask?.let { card ->
                        AskUserCardView(
                            card = card,
                            onSubmit = { picked, free -> vm.answerAsk(picked, free) },
                            onDismiss = vm::dismissAsk,
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
                    val models = st.sheet?.models.orEmpty().map { SelectOption(it.id, it.label) }
                    if (models.isNotEmpty()) {
                        val modelLabel = models.find { it.value == st.model }?.label ?: st.model
                        ComposerPicker(
                            icon = R.drawable.lucide_bot,
                            label = modelLabel.ifBlank { stringResource(R.string.model_picker) },
                            compact = compact,
                            options = models,
                            value = st.model,
                            onChange = vm::setModel,
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
                },
            )
        }
    }
}

@Composable
private fun ChatTranscript(vm: HarnessChatViewModel, accent: androidx.compose.ui.graphics.Color) {
    val st by vm.state.collectAsState()
    val ctx = LocalContext.current
    val colors = RivetTheme.colors
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val liveExtra = if (st.inFlight || st.liveText.isNotBlank() || st.liveReasoning.isNotBlank()) 1 else 0
    val count = st.turns.size + liveExtra
    // transcript.tsx:385-480 port (plane/TranscriptPin.kt): pinned starts
    // true; the first non-empty load jumps to the end unconditionally (a chat
    // opens at the bottom of the thread); afterwards new content follows ONLY
    // while within 120dp of the bottom; the ↓ latest pill re-pins.
    val pin = remember { TranscriptPin() }
    var pinned by remember { mutableStateOf(true) }
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
    LaunchedEffect(Unit) {
        snapshotFlow { distanceFromBottom }.collect { d ->
            pin.onScroll(with(density) { d.toDp().value })
            pinned = pin.pinned
        }
    }
    LaunchedEffect(count, st.liveText.length, st.liveReasoning.length) {
        if (pin.onContent(count)) {
            // Index `count` = the trailing spacer — scrolling it into view
            // lands on the very bottom of the thread.
            runCatching { list.scrollToItem(count) }
        }
        pinned = pin.pinned
    }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
        itemsIndexed(st.turns, key = { i, turn -> "$i:${turn.role}" }) { _, turn ->
            val split = if (turn.role != "user") splitHermesReasoning(turn.text) else null
            val thinking = turn.thinking?.takeIf { it.isNotBlank() } ?: split?.reasoning.orEmpty()
            val body = split?.text ?: turn.text
            if (turn.role == "user") {
                TranscriptUserTurn(
                    text = body,
                    time = null,
                    onCopy = { copyText(ctx, it) },
                )
            } else {
                TranscriptAssistantTurn(
                    text = body,
                    thinking = thinking.takeIf { it.isNotBlank() },
                    model = turn.model,
                    time = null,
                    accent = accent,
                    tools = turn.tools.orEmpty().map {
                        ToolRow(humanToolTitle(it.name, toolArgStrings(it.args)), it.status)
                    },
                    stats = statsLineOrNull(turn.usage),
                    onCopy = { copyText(ctx, it) },
                )
            }
        }
        if (st.inFlight || st.liveText.isNotBlank() || st.liveReasoning.isNotBlank()) {
            item {
                TranscriptAssistantTurn(
                    text = st.liveText,
                    thinking = st.liveReasoning.takeIf { it.isNotBlank() },
                    model = st.model.takeIf { it.isNotBlank() },
                    time = null,
                    accent = accent,
                    tools = emptyList(),
                    stats = null,
                    onCopy = { copyText(ctx, it) },
                    thinkingOpenDefault = st.liveReasoning.isNotBlank() && st.liveText.isBlank(),
                )
            }
        }
            item { Spacer(Modifier.height(Dimens.grid2)) }
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
