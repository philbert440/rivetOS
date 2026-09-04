package io.rivethub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.rivethub.app.R
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.TopBarTitle
import io.rivethub.app.plane.accentFor
import io.rivethub.app.plane.composerCanSend
import io.rivethub.app.plane.composerIsEnabled
import io.rivethub.app.plane.contextBarView
import io.rivethub.app.plane.humanToolTitle
import io.rivethub.app.plane.statsLineOrNull
import io.rivethub.app.plane.toolArgStrings
import io.rivethub.app.plane.topBarTitle
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.components.AskUserCardView
import io.rivethub.app.ui.components.ChatSessionHeader
import io.rivethub.app.ui.components.ChatStatusStrip
import io.rivethub.app.ui.components.Composer
import io.rivethub.app.ui.components.ComposerPicker
import io.rivethub.app.ui.components.ModePager
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.components.TerminalRetryState
import io.rivethub.app.ui.components.ToolRow
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.components.TranscriptAssistantTurn
import io.rivethub.app.ui.components.TranscriptUserTurn
import io.rivethub.app.ui.components.rivetHexColor
import io.rivethub.app.ui.term.TerminalKeyBar
import io.rivethub.app.ui.term.TerminalPane
import io.rivethub.app.ui.term.clipboardText
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens

@Composable
fun HarnessChatScreen(vm: HarnessChatViewModel, onBack: () -> Unit) {
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
        // D2-1: the web mobile top bar stays above the session back row
        // (routes.tsx:107 mounts MobileTopBar above <main>); no drawer here,
        // so the DenBot is decorative.
        TopBar(
            title = stringResource(
                when (topBarTitle(null)) {
                    TopBarTitle.Wordmark -> R.string.brand_rivethub
                    TopBarTitle.Settings -> R.string.title_settings
                },
            ),
            onOpenDrawer = null,
        )
        ChatSessionHeader(
            sessionLabel = sessionLabel,
            context = context,
            modeOptions = pages,
            selectedMode = selected,
            onSelectMode = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            onBack = onBack,
            showStop = st.inFlight && st.gate.canInterrupt && !st.draft,
            onStop = vm::stop,
        )
        if (st.ws == WsStatus.CONNECTING) {
            ChatStatusStrip(reconnecting, error = false)
        } else if (st.ws == WsStatus.CLOSED) {
            ChatStatusStrip(stringResource(R.string.ws_disconnected), error = true)
        }
        stripError?.let { ChatStatusStrip("✗ $it", error = true) }
        ModePager(
            pages = pages,
            selected = selected,
            onSelect = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            swipe = true,
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
    val list = rememberLazyListState()
    val last = st.turns.size + if (st.inFlight || st.liveText.isNotBlank()) 1 else 0
    LaunchedEffect(st.turns.size, st.inFlight) {
        val lastVisible = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index
        if (last > 0 && (lastVisible == null || last - lastVisible <= 2)) {
            runCatching { list.animateScrollToItem(last) }
        }
    }
    LaunchedEffect(st.liveText) {
        val lastVisible = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index
        if (last > 0 && (lastVisible == null || last - lastVisible <= 2)) {
            runCatching { list.scrollToItem(last) }
        }
    }
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
}
