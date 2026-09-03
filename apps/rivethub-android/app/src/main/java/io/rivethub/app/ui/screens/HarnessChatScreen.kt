package io.rivethub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import io.rivethub.app.R
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.components.Bubble
import io.rivethub.app.ui.components.Composer
import io.rivethub.app.ui.components.FoldChip
import io.rivethub.app.ui.components.MessageBubble
import io.rivethub.app.ui.components.ModePager
import io.rivethub.app.ui.components.Pill
import io.rivethub.app.ui.components.PrimaryButton
import io.rivethub.app.ui.components.RivetSelect
import io.rivethub.app.ui.components.SegmentedControl
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.components.StreamChip
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.term.TerminalKeyBar
import io.rivethub.app.ui.term.TerminalPane
import io.rivethub.app.ui.term.clipboardText
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun HarnessChatScreen(vm: HarnessChatViewModel, onBack: () -> Unit) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val ctx = LocalContext.current
    val chatLabel = stringResource(R.string.mode_chat)
    val termLabel = stringResource(R.string.mode_terminal)
    val pages = listOf(chatLabel, termLabel)
    val selected = if (st.mode == SessionMode.Terminal) termLabel else chatLabel
    var ctrl by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { vm.onAppBackground() }
    LifecycleEventEffect(Lifecycle.Event.ON_START) { vm.onAppForeground() }
    LaunchedEffect(st.mode) {
        if (st.mode == SessionMode.Terminal) vm.ensureTerminal()
    }
    LaunchedEffect(st.termClipboard) {
        val clip = st.termClipboard ?: return@LaunchedEffect
        copyText(ctx, clip)
        vm.consumeTermClipboard()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@rememberLauncherForActivityResult
        var name = uri.lastPathSegment ?: "file"
        var mime: String? = ctx.contentResolver.getType(uri)
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cur ->
            if (cur.moveToFirst()) name = cur.getString(0) ?: name
        }
        vm.stageBytes(bytes, name, mime)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding(),
    ) {
        TopBar(
            title = st.title,
            onBack = onBack,
            actions = {
                TopIcon(Icons.Outlined.MoreHoriz, stringResource(R.string.action_more)) { vm.setMoreOpen(!st.moreOpen) }
            },
            subRow = {
                Row(
                    Modifier.padding(start = Dimens.touchTarget, end = Dimens.grid, bottom = Dimens.gridHalf),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SegmentedControl(
                        options = pages,
                        selected = selected,
                        onSelect = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
                    )
                    if (st.model.isNotBlank()) Pill(st.model)
                    Pill(st.nodeName)
                }
            },
        )
        st.error?.let {
            Text(it, color = colors.red, style = RivetType.meta, modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf))
        }
        ModePager(
            pages = pages,
            selected = selected,
            onSelect = { vm.setMode(if (it == termLabel) SessionMode.Terminal else SessionMode.Chat) },
            swipe = true,
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
                    ctrl = ctrl,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                ChatTranscript(vm)
            }
        }
        if (st.mode == SessionMode.Terminal) {
            TerminalKeyBar(
                ctrl = ctrl,
                onCtrl = { ctrl = !ctrl },
                onBytes = vm::sendTermBytes,
                onPaste = {
                    val text = clipboardText(ctx) ?: return@TerminalKeyBar
                    vm.sendTermText(text, ctrl)
                },
                attachCommand = st.attachCommand,
                onOpenInTerminal = {
                    val cmd = st.attachCommand ?: return@TerminalKeyBar
                    copyText(ctx, cmd)
                },
                onDetach = vm::userDetachTerminal,
            )
        } else {
            Composer(
                value = st.composer,
                onValueChange = vm::setComposer,
                placeholder = stringResource(R.string.composer_placeholder),
                live = st.inFlight,
                pickers = {
                    val models = st.sheet?.models.orEmpty().map { SelectOption(it.id, it.label) }
                    if (models.isNotEmpty()) {
                        RivetSelect(
                            value = st.model,
                            options = models,
                            onChange = vm::setModel,
                            title = stringResource(R.string.model_picker),
                        )
                    }
                    val efforts = vm.effortOptions().map { SelectOption(it.first, it.second) }
                    if (efforts.isNotEmpty()) {
                        RivetSelect(
                            value = st.effort,
                            options = efforts,
                            onChange = vm::setEffort,
                            title = stringResource(R.string.effort_picker),
                        )
                    }
                },
                chips = {
                    st.attachments.forEach { a ->
                        Pill(
                            text = a.name,
                            modifier = Modifier.clickable { vm.removeAttachment(a.id) },
                        )
                    }
                },
                onAttach = { pick.launch(arrayOf("*/*")) },
                onSend = vm::send,
                onStop = vm::stop,
                enabled = true,
            )
        }
    }
}

@Composable
private fun ChatTranscript(vm: HarnessChatViewModel) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val list = rememberLazyListState()
    var folds by remember { mutableStateOf(setOf<Int>()) }
    LaunchedEffect(st.turns.size, st.liveText, st.inFlight) {
        val last = st.turns.size + if (st.inFlight || st.liveText.isNotBlank()) 1 else 0
        if (last > 0) runCatching { list.animateScrollToItem(last) }
    }
    LazyColumn(
        state = list,
        modifier = Modifier.fillMaxSize().padding(horizontal = Dimens.grid2),
        verticalArrangement = Arrangement.spacedBy(Dimens.grid),
    ) {
        item { Spacer(Modifier.height(Dimens.grid)) }
        itemsIndexed(st.turns) { i, turn ->
            val kind = if (turn.role == "user") Bubble.User else Bubble.Assistant
            val split = if (kind == Bubble.Assistant) splitHermesReasoning(turn.text) else null
            val thinking = turn.thinking?.takeIf { it.isNotBlank() } ?: split?.reasoning.orEmpty()
            val body = split?.text ?: turn.text
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (thinking.isNotBlank()) {
                    val open = i in folds
                    FoldChip(
                        text = stringResource(R.string.thinking_chip),
                        expanded = open,
                        onClick = { folds = if (open) folds - i else folds + i },
                    )
                    if (open) {
                        Text(thinking, color = colors.inkDim, style = RivetType.meta)
                    }
                }
                if (body.isNotBlank()) {
                    MessageBubble(kind) { Text(body) }
                }
            }
        }
        if (st.inFlight || st.liveText.isNotBlank() || st.liveReasoning.isNotBlank()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (st.liveReasoning.isNotBlank()) {
                        FoldChip(text = stringResource(R.string.thinking_chip), expanded = true)
                        Text(st.liveReasoning, color = colors.inkDim, style = RivetType.meta)
                    }
                    if (st.liveText.isNotBlank()) {
                        MessageBubble(Bubble.Assistant) { Text(st.liveText) }
                    }
                    if (st.inFlight) StreamChip(stringResource(R.string.stream_chip))
                }
            }
        }
        st.ask?.let { card ->
            item { AskCard(card, onPick = { vm.answerAsk(it, "") }, onDismiss = vm::dismissAsk) }
        }
        item { Spacer(Modifier.height(Dimens.grid2)) }
    }
}

@Composable
private fun AskCard(
    card: io.rivethub.app.plane.AskUserCard,
    onPick: (Map<Int, List<String>>) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(colors.panel)
            .padding(Dimens.grid2),
        verticalArrangement = Arrangement.spacedBy(Dimens.grid),
    ) {
        Text(stringResource(R.string.ask_user_title), color = colors.ink, style = RivetType.title)
        card.questions.forEachIndexed { qi, q ->
            Text(q.header ?: q.question ?: "", color = colors.ink, style = RivetType.body)
            q.options.forEach { opt ->
                PrimaryButton(
                    text = opt.label,
                    onClick = { onPick(mapOf(qi to listOf(opt.label))) },
                    modifier = Modifier.fillMaxWidth(),
                )
                opt.description?.let { Text(it, color = colors.inkDim, style = RivetType.meta) }
            }
        }
        Text(
            stringResource(R.string.action_cancel),
            color = colors.inkDim,
            style = RivetType.meta,
            modifier = Modifier.clickable(onClick = onDismiss).padding(vertical = Dimens.grid),
        )
    }
}
