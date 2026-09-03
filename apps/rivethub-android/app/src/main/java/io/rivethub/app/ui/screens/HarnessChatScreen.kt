package io.rivethub.app.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import io.rivethub.app.R
import io.rivethub.app.data.splitHermesReasoning
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.components.Bubble
import io.rivethub.app.ui.components.Composer
import io.rivethub.app.ui.components.FoldChip
import io.rivethub.app.ui.components.MessageBubble
import io.rivethub.app.ui.components.ModePager
import io.rivethub.app.ui.components.Pill
import io.rivethub.app.ui.components.PillTone
import io.rivethub.app.ui.components.PrimaryButton
import io.rivethub.app.ui.components.RivetSelect
import io.rivethub.app.ui.components.SegmentedControl
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.components.StreamChip
import io.rivethub.app.ui.components.TopBar
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

    val composerEnabled = st.ws != WsStatus.CLOSED && st.error == null
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
                    if (st.ws == WsStatus.CONNECTING) Pill(stringResource(R.string.ws_reconnecting), tone = PillTone.Warn)
                    if (st.ws == WsStatus.CLOSED) Pill(stringResource(R.string.ws_disconnected), tone = PillTone.Warn)
                }
            },
        )
        st.error?.let {
            Text(it, color = colors.red, style = RivetType.meta, modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf))
        }
        when (st.errorCode) {
            HarnessChatViewModel.ERR_UPLOADING -> Text(
                stringResource(R.string.error_upload_in_progress),
                color = colors.red,
                style = RivetType.meta,
                modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf),
            )
            HarnessChatViewModel.ERR_TOO_LARGE -> Text(
                stringResource(R.string.error_upload_too_large),
                color = colors.red,
                style = RivetType.meta,
                modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf),
            )
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
                Box(Modifier.fillMaxSize().padding(Dimens.grid2)) {
                    Text(stringResource(R.string.terminal_placeholder), color = colors.inkDim, style = RivetType.body)
                }
            } else {
                ChatTranscript(vm)
            }
        }
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
                    val label = when (a.status) {
                        AttachmentStatus.UPLOADING -> stringResource(R.string.chip_uploading, a.name)
                        AttachmentStatus.FAILED -> stringResource(R.string.chip_failed, a.name)
                        AttachmentStatus.READY -> a.name
                    }
                    Pill(
                        text = label,
                        tone = if (a.status == AttachmentStatus.FAILED) PillTone.Warn else PillTone.Dim,
                        modifier = Modifier.clickable { vm.removeAttachment(a.id) },
                    )
                }
            },
            onAttach = { pick.launch(arrayOf("*/*")) },
            onSend = vm::send,
            onStop = vm::stop,
            enabled = composerEnabled,
            canStop = st.gate.canInterrupt,
        )
    }
}

@Composable
private fun ChatTranscript(vm: HarnessChatViewModel) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val list = rememberLazyListState()
    var folds by remember { mutableStateOf(setOf<String>()) }
    val last = st.turns.size + if (st.inFlight || st.liveText.isNotBlank()) 1 else 0
    LaunchedEffect(st.turns.size, st.inFlight) {
        if (last > 0) runCatching { list.animateScrollToItem(last) }
    }
    LaunchedEffect(st.liveText) {
        val lastVisible = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: return@LaunchedEffect
        if (last > 0 && last - lastVisible <= 2) {
            runCatching { list.scrollToItem(last) }
        }
    }
    LazyColumn(
        state = list,
        modifier = Modifier.fillMaxSize().padding(horizontal = Dimens.grid2),
        verticalArrangement = Arrangement.spacedBy(Dimens.grid),
    ) {
        item { Spacer(Modifier.height(Dimens.grid)) }
        itemsIndexed(st.turns, key = { i, turn -> "$i:${turnKey(turn)}" }) { _, turn ->
            val kind = if (turn.role == "user") Bubble.User else Bubble.Assistant
            val split = if (kind == Bubble.Assistant) splitHermesReasoning(turn.text) else null
            val thinking = turn.thinking?.takeIf { it.isNotBlank() } ?: split?.reasoning.orEmpty()
            val body = split?.text ?: turn.text
            val key = turnKey(turn)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (thinking.isNotBlank()) {
                    val open = key in folds
                    FoldChip(
                        text = stringResource(R.string.thinking_chip),
                        expanded = open,
                        onClick = { folds = if (open) folds - key else folds + key },
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
            item { AskCard(card, onSubmit = { picked, free -> vm.answerAsk(picked, free) }, onDismiss = vm::dismissAsk) }
        }
        item { Spacer(Modifier.height(Dimens.grid2)) }
    }
}

private fun turnKey(turn: io.rivethub.app.gateway.HarnessTranscriptTurn): String =
    "${turn.role}\n${turn.text}\n${turn.thinking.orEmpty()}\n${turn.model.orEmpty()}"

@Composable
private fun AskCard(
    card: io.rivethub.app.plane.AskUserCard,
    onSubmit: (Map<Int, List<String>>, String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    var picked by remember { mutableStateOf(mapOf<Int, List<String>>()) }
    var free by remember { mutableStateOf("") }
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
                val selected = picked[qi].orEmpty().contains(opt.label)
                PrimaryButton(
                    text = opt.label,
                    onClick = {
                        picked = picked.toMutableMap().apply {
                            val cur = this[qi].orEmpty()
                            this[qi] = if (q.multiSelect) {
                                if (opt.label in cur) cur - opt.label else cur + opt.label
                            } else {
                                listOf(opt.label)
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = true,
                )
                if (selected) {
                    Text(stringResource(R.string.ask_user_selected), color = colors.em, style = RivetType.meta)
                }
                opt.description?.let { Text(it, color = colors.inkDim, style = RivetType.meta) }
            }
        }
        RivetField(
            value = free,
            onValueChange = { free = it },
            placeholder = stringResource(R.string.ask_user_free),
        )
        PrimaryButton(
            text = stringResource(R.string.action_submit),
            onClick = { onSubmit(picked, free) },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            stringResource(R.string.action_cancel),
            color = colors.inkDim,
            style = RivetType.meta,
            modifier = Modifier.clickable(onClick = onDismiss).padding(vertical = Dimens.grid),
        )
    }
}
