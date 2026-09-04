package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.ConversationEmptyKind
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.NewConversationAction
import io.rivethub.app.plane.accentForConversation
import io.rivethub.app.plane.conversationEmptyKind
import io.rivethub.app.plane.discoveringLineVisible
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.filterConversations
import io.rivethub.app.plane.isActiveStatus
import io.rivethub.app.plane.newConversationAction
import io.rivethub.app.plane.paneRows
import io.rivethub.app.plane.rowPillText
import io.rivethub.app.plane.showConversationFilter
import io.rivethub.app.plane.topBarTitle
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.TopBarTitle
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.ConversationRowChrome
import io.rivethub.app.ui.components.ConversationRowStatus as RowStatus
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.RivetModalSheet
import io.rivethub.app.ui.components.SheetTextRow
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.components.rivetHexColor
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.launch

@Composable
fun ConversationsScreen(
    vm: HubViewModel,
    onOpenRow: (LocatedChatItem) -> Unit,
    onOpenChat: (AgentOpen) -> Unit,
    onOpenDrawer: () -> Unit,
) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val lists = filterConversations(
        items = st.items,
        filter = st.filter,
        archived = st.archived,
        query = st.query,
        titleOverrides = st.titleOverrides,
    )
    var archivedOpen by remember { mutableStateOf(false) }
    var menuTarget by remember { mutableStateOf<LocatedChatItem?>(null) }
    var renameTarget by remember { mutableStateOf<LocatedChatItem?>(null) }
    var discardTarget by remember { mutableStateOf<LocatedChatItem?>(null) }
    var renameText by remember { mutableStateOf("") }
    var pickerOpen by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val noAgentsHint = stringResource(R.string.no_agents_hint)
    val liveCount = lists.live.size
    val empty = conversationEmptyKind(
        lists.live.size + lists.archived.size,
        lists.live.size,
        lists.archived.size,
        st.query,
    )
    val ptr = rememberPullToRefreshState()
    // D2-8: no circular spinner floats over the rows on auto-refresh — the pull
    // indicator only answers a user pull; progress is the `discovering… n/m` line.
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(st.loading) { if (!st.loading) pulled = false }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.panel.copy(alpha = 0.4f)),
    ) {
        TopBar(
            title = stringResource(
                when (topBarTitle(HubTab.Conversations)) {
                    TopBarTitle.Wordmark -> R.string.brand_rivethub
                    TopBarTitle.Settings -> R.string.title_settings
                },
            ),
            onOpenDrawer = onOpenDrawer,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    stringResource(R.string.conversations_label),
                    color = colors.inkDim,
                    style = RivetType.xs.copy(fontFamily = RivetType.mono11.fontFamily),
                    maxLines = 1,
                )
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(if (st.registryOpen) colors.em else colors.red),
                )
                Text(
                    " ($liveCount)",
                    color = colors.inkDim,
                    style = RivetType.xs.copy(fontFamily = RivetType.mono11.fontFamily),
                    maxLines = 1,
                )
            }
            NewConversationButton(
                onClick = {
                    when (val action = newConversationAction(st.prefs.currentAgentId, st.agents.map { it.agentId })) {
                        is NewConversationAction.ForAgent -> {
                            val row = st.agents.find { it.agentId == action.agentId }
                            if (row != null) onOpenChat(vm.openAgentAction(row, AgentAction.Plus))
                        }
                        NewConversationAction.PickAgent -> {
                            if (st.agents.isEmpty()) {
                                scope.launch { snackbar.showSnackbar(noAgentsHint) }
                            } else {
                                pickerOpen = true
                            }
                        }
                    }
                },
            )
        }
        if (showConversationFilter(lists.live.size + lists.archived.size, st.query)) {
            RivetField(
                value = st.query,
                onValueChange = vm::setQuery,
                placeholder = stringResource(R.string.filter_placeholder),
                size = RivetFieldSize.Filter,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
            )
        }
        HubErrorLine(st.error, st.errorKind, onRetry = vm::refresh)
        Column(Modifier.weight(1f).fillMaxWidth().navigationBarsPadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                PullToRefreshBox(
                    isRefreshing = pulled && st.loading,
                    onRefresh = {
                        pulled = true
                        vm.refresh()
                    },
                    state = ptr,
                    indicator = {
                        PullToRefreshDefaults.Indicator(
                            modifier = Modifier.align(Alignment.TopCenter),
                            isRefreshing = pulled && st.loading,
                            containerColor = colors.panel2,
                            color = colors.em,
                            state = ptr,
                        )
                    },
                ) {
                    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
                        when (empty) {
                            ConversationEmptyKind.NoConversations -> item {
                                EmptyLine(stringResource(R.string.empty_conversations))
                            }
                            ConversationEmptyKind.NoMatches -> item {
                                EmptyLine(stringResource(R.string.empty_search_for, st.query.trim()))
                            }
                            ConversationEmptyKind.AllArchived -> item {
                                EmptyLine(stringResource(R.string.everything_archived))
                            }
                            ConversationEmptyKind.None -> Unit
                        }
                        items(paneRows(lists.live), key = { it.item.key }) { row ->
                            val title = displayTitle(row.item, st.titleOverrides)
                            val agentId = vm.agentForSession(row.item.key)
                            val preset = st.agents.find { it.agentId == agentId }?.color
                            val hex = accentForConversation(preset, row.item.harnessId, row.item.command)
                            ConversationRowChrome(
                                title = title,
                                accent = rivetHexColor(hex),
                                onOpen = { onOpenRow(row) },
                                onArchive = { vm.archive(row.item.key) },
                                onLong = { menuTarget = row },
                                rowKey = row.item.key,
                                status = rowStatus(row),
                                harness = rowPillText(row.item.model, null, row.item.harnessId),
                            )
                        }
                        if (archivedOpen) {
                            items(paneRows(lists.archived), key = { "arch-${it.item.key}" }) { row ->
                                val title = displayTitle(row.item, st.titleOverrides)
                                val agentId = vm.agentForSession(row.item.key)
                                val preset = st.agents.find { it.agentId == agentId }?.color
                                val hex = accentForConversation(preset, row.item.harnessId, row.item.command)
                                ConversationRowChrome(
                                    title = title,
                                    accent = rivetHexColor(hex),
                                    onOpen = { vm.unarchive(row.item.key); onOpenRow(row) },
                                    onArchive = { vm.unarchive(row.item.key) },
                                    onLong = { menuTarget = row },
                                    rowKey = "arch-${row.item.key}",
                                    archived = true,
                                    harness = rowPillText(row.item.model, null, row.item.harnessId),
                                )
                            }
                        }
                        item { HubDiscoveringLine(st.discoveringDone, st.discoveringTotal) }
                        item { Spacer(Modifier.height(24.dp)) }
                    }
                }
                SnackbarHost(
                    hostState = snackbar,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
                ) { data ->
                    val shape = RoundedCornerShape(Radius.md)
                    Snackbar(
                        snackbarData = data,
                        containerColor = colors.panel2,
                        contentColor = colors.ink,
                        actionColor = colors.em,
                        shape = shape,
                        modifier = Modifier.border(1.dp, colors.line, shape),
                    )
                }
            }
            if (lists.archived.isNotEmpty()) {
                Text(
                    stringResource(
                        if (archivedOpen) R.string.archived_expanded else R.string.archived_collapsed,
                        lists.archived.size,
                    ),
                    color = colors.inkDim,
                    style = RivetType.mono11,
                    modifier = Modifier
                        .fillMaxWidth()
                        .drawArchivedBorder(colors.line)
                        .clickable { archivedOpen = !archivedOpen }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
    }

    if (pickerOpen) {
        RivetModalSheet(onDismiss = { pickerOpen = false }) {
            Text(
                stringResource(R.string.pick_agent),
                color = colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
            st.agents.forEach { agent ->
                Text(
                    "${agent.name} · ${agent.nodeName}",
                    color = colors.ink,
                    style = RivetType.xs,
                    modifier = Modifier
                        .fillMaxWidth()
                        .sizeIn(minHeight = 44.dp)
                        .clickable {
                            pickerOpen = false
                            onOpenChat(vm.openAgentAction(agent, AgentAction.Plus))
                        }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
    }

    menuTarget?.let { target ->
        ConversationMenuSheet(
            target = target,
            title = displayTitle(target.item, st.titleOverrides),
            archived = target.item.key in st.archived,
            onDismiss = { menuTarget = null },
            onRename = {
                renameText = displayTitle(target.item, st.titleOverrides)
                renameTarget = target
                menuTarget = null
            },
            onArchive = {
                if (target.item.key in st.archived) vm.unarchive(target.item.key) else vm.archive(target.item.key)
                menuTarget = null
            },
            onDiscard = {
                discardTarget = target
                menuTarget = null
            },
        )
    }

    renameTarget?.let { target ->
        RivetModalSheet(onDismiss = { renameTarget = null }) {
            Column(Modifier.imePadding()) {
                Text(
                    stringResource(R.string.rename_title),
                    color = colors.em,
                    style = RivetType.sm,
                    modifier = Modifier.padding(8.dp),
                )
                RivetField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    placeholder = stringResource(R.string.rename_hint),
                    size = RivetFieldSize.Rename,
                )
                Row(
                    Modifier.padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    io.rivethub.app.ui.components.RivetButton(
                        text = stringResource(R.string.action_save),
                        onClick = {
                            vm.rename(target.item.key, renameText)
                            renameTarget = null
                        },
                    )
                    io.rivethub.app.ui.components.RivetButton(
                        text = stringResource(R.string.action_cancel),
                        onClick = { renameTarget = null },
                        variant = io.rivethub.app.ui.components.RivetButtonVariant.Outline,
                    )
                }
            }
        }
    }

    discardTarget?.let { target ->
        RivetConfirmDialog(
            title = stringResource(R.string.discard_title),
            message = stringResource(R.string.discard_body),
            confirmLabel = stringResource(R.string.action_discard),
            cancelLabel = stringResource(R.string.action_cancel),
            danger = true,
            onConfirm = {
                vm.discardDraft(target.item.key)
                discardTarget = null
            },
            onDismiss = { discardTarget = null },
        )
    }
}

@Composable
private fun ConversationMenuSheet(
    target: LocatedChatItem,
    title: String,
    archived: Boolean,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
    onDiscard: () -> Unit,
) {
    val colors = RivetTheme.colors
    val draft = target.item.kind == ChatItemKind.DRAFT && !target.item.pin
    RivetModalSheet(onDismiss = onDismiss) {
        Text(title, color = colors.em, style = RivetType.sm, modifier = Modifier.padding(8.dp), maxLines = 1)
        SheetTextRow(stringResource(R.string.action_rename), colors.ink, onRename)
        SheetTextRow(
            stringResource(if (archived) R.string.action_unarchive else R.string.action_archive),
            colors.ink,
            onArchive,
        )
        if (draft) {
            SheetTextRow(stringResource(R.string.action_discard), colors.red, onDiscard)
        }
    }
}

/**
 * chat.tsx:808-817 — `+ new` is NOT a `ui/button.tsx` Button on the web; it is
 * a raw `rounded border border-line px-2 py-1 text-xs text-ink-dim` button
 * (hover → `border-em text-em`, mapped to pressed).
 */
@Composable
private fun NewConversationButton(onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(Radius.sm)
    // 44dp hit box around the source-sized bordered label (button.tsx look, phone target).
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .sizeIn(minWidth = Dimens.touchTarget, minHeight = Dimens.touchTarget)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            ),
    ) {
        Text(
            stringResource(R.string.action_new_plus),
            color = if (pressed) colors.em else colors.inkDim,
            style = RivetType.xs,
            maxLines = 1,
            modifier = Modifier
                .clip(shape)
                .border(1.dp, if (pressed) colors.em else colors.line, shape)
                .padding(horizontal = 8.dp, vertical = 4.dp),
        )
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

@Composable
private fun rowStatus(row: LocatedChatItem): RowStatus = when {
    isActiveStatus(row.item.status) -> RowStatus.InFlight
    row.item.status?.equals("idle", ignoreCase = true) == true -> RowStatus.Alive
    else -> RowStatus.None
}

@Composable
internal fun HubDiscoveringLine(done: Int, total: Int) {
    if (!discoveringLineVisible(done, total)) return
    val colors = RivetTheme.colors
    Text(
        stringResource(R.string.discovering_progress, done, total),
        color = colors.inkDim,
        style = RivetType.mono10,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

@Composable
internal fun HubErrorLine(error: String?, kind: EnrollErrorKind?, onRetry: (() -> Unit)? = null) {
    if (error == null && kind == null) return
    val colors = RivetTheme.colors
    val text = when (kind) {
        EnrollErrorKind.Cleartext -> stringResource(R.string.error_https_required)
        EnrollErrorKind.Timeout -> stringResource(R.string.error_timeout)
        EnrollErrorKind.Unreachable -> stringResource(R.string.error_unreachable)
        EnrollErrorKind.CertRefused -> stringResource(R.string.error_cert_required)
        EnrollErrorKind.Other, null -> error ?: return
    }
    Text(
        text,
        color = colors.red,
        style = RivetType.xs,
        modifier = Modifier
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .then(if (onRetry != null) Modifier.clickable(onClick = onRetry) else Modifier),
    )
}

private fun Modifier.drawArchivedBorder(color: androidx.compose.ui.graphics.Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(
            color,
            Offset(0f, stroke / 2f),
            Offset(size.width, stroke / 2f),
            stroke,
        )
    }
