package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AccentToken
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.FILTER_ALL
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.conversationsFilterChips
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.filterConversations
import io.rivethub.app.plane.harnessAccentToken
import io.rivethub.app.plane.relativeAge
import io.rivethub.app.plane.rowPillText
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.FilterChipRow
import io.rivethub.app.ui.components.ListRow
import io.rivethub.app.ui.components.Pill
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.OnEm
import io.rivethub.app.ui.theme.RivetColors
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun ConversationsScreen(
    vm: HubViewModel,
    onOpenRow: (LocatedChatItem) -> Unit,
    onNew: () -> Unit,
) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val nodeNames = st.nodes.map { it.name.ifBlank { it.id } }.distinct()
    val chips = conversationsFilterChips(nodeNames)
    val lists = filterConversations(
        items = st.items,
        filter = st.filter.ifBlank { FILTER_ALL },
        archived = st.archived,
        pinnedKeys = vm.pinnedKeys(),
        query = st.query,
        titleOverrides = st.titleOverrides,
    )
    var archivedOpen by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<LocatedChatItem?>(null) }
    var discardTarget by remember { mutableStateOf<LocatedChatItem?>(null) }
    var renameText by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(
            title = stringResource(R.string.title_conversations),
            actions = {
                TopIcon(Icons.Outlined.Search, stringResource(R.string.action_search)) { vm.setSearchOpen(!st.searchOpen) }
                TopIcon(Icons.Outlined.NotificationsNone, stringResource(R.string.action_notifications)) { vm.setInboxOpen(true) }
            },
        )
        if (st.searchOpen) {
            RivetField(
                value = st.query,
                onValueChange = vm::setQuery,
                placeholder = stringResource(R.string.search_conversations),
                modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf),
            )
        }
        FilterChipRow(
            options = chips,
            selected = st.filter.ifBlank { FILTER_ALL },
            onSelect = vm::setFilter,
            modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
        )
        st.error?.let {
            Text(it, color = colors.red, style = RivetType.meta, modifier = Modifier.padding(horizontal = Dimens.grid2))
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (lists.live.isEmpty() && lists.archived.isEmpty()) {
                    item {
                        Text(
                            if (st.query.isNotBlank()) stringResource(R.string.empty_search) else stringResource(R.string.empty_conversations),
                            color = colors.inkDim,
                            style = RivetType.meta,
                            modifier = Modifier.padding(Dimens.grid2),
                        )
                    }
                }
                if (lists.live.isEmpty() && lists.archived.isNotEmpty() && st.query.isBlank()) {
                    item {
                        Text(
                            stringResource(R.string.everything_archived),
                            color = colors.inkDim,
                            style = RivetType.meta,
                            modifier = Modifier.padding(Dimens.grid2),
                        )
                    }
                }
                items(lists.live, key = { it.item.key }) { row ->
                    ConversationRow(
                        row = row,
                        title = displayTitle(row.item, st.titleOverrides),
                        onOpen = { onOpenRow(row) },
                        onArchive = { vm.archive(row.item.key) },
                        onLong = {
                            if (row.item.kind == ChatItemKind.DRAFT && !row.item.pin) discardTarget = row
                            else {
                                renameTarget = row
                                renameText = displayTitle(row.item, st.titleOverrides)
                            }
                        },
                    )
                }
                if (lists.archived.isNotEmpty()) {
                    item {
                        Text(
                            stringResource(R.string.archived_section, lists.archived.size),
                            color = colors.inkDim,
                            style = RivetType.monoPill,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { archivedOpen = !archivedOpen }
                                .padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
                        )
                    }
                    if (archivedOpen) {
                        items(lists.archived, key = { "arch-${it.item.key}" }) { row ->
                            ConversationRow(
                                row = row,
                                title = displayTitle(row.item, st.titleOverrides),
                                dim = true,
                                onOpen = { vm.unarchive(row.item.key); onOpenRow(row) },
                                onArchive = { vm.unarchive(row.item.key) },
                                onLong = { vm.unarchive(row.item.key) },
                            )
                        }
                    }
                }
                item { Spacer(Modifier.height(72.dp)) }
            }
            FloatingActionButton(
                onClick = onNew,
                containerColor = colors.em,
                contentColor = OnEm,
                modifier = Modifier.align(Alignment.BottomEnd).padding(Dimens.grid2),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.action_new))
            }
        }
    }

    if (st.inboxOpen) {
        InboxSheet(st.inbox, onDismiss = { vm.setInboxOpen(false) })
    }
    renameTarget?.let { target ->
        RenameDialog(
            title = stringResource(R.string.rename_title),
            value = renameText,
            onValue = { renameText = it },
            onSave = {
                vm.rename(target.item.key, renameText)
                renameTarget = null
            },
            onDismiss = { renameTarget = null },
        )
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
private fun ConversationRow(
    row: LocatedChatItem,
    title: String,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
    onLong: () -> Unit,
    dim: Boolean = false,
) {
    val colors = RivetTheme.colors
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { v ->
            if (v == SwipeToDismissBoxValue.EndToStart) {
                onArchive()
                true
            } else false
        },
    )
    val accent = harnessAccentToken(row.item.harnessId, row.item.command).color(colors)
    val pill = rowPillText(row.item.model, null, row.item.harnessId)
    val age = relativeAge(row.item.updatedAt, System.currentTimeMillis())
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(
                Modifier.fillMaxSize().background(colors.red).padding(horizontal = Dimens.grid2),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Text(stringResource(R.string.action_archive), color = colors.bg, style = RivetType.meta)
            }
        },
    ) {
        ListRow(
            title = title,
            onClick = onOpen,
            onLongClick = onLong,
            accent = accent,
            dim = dim,
            pinned = row.item.pin,
            meta = {
                if (pill.isNotBlank()) {
                    Pill(pill)
                    Spacer(Modifier.size(6.dp))
                }
                Pill(row.nodeName)
                Spacer(Modifier.size(6.dp))
                Text(ageLabel(age), color = colors.inkDim, style = RivetType.meta)
            },
        )
    }
}

@Composable
internal fun ageLabel(age: io.rivethub.app.plane.RelativeAge): String = when (age) {
    io.rivethub.app.plane.RelativeAge.Empty -> ""
    io.rivethub.app.plane.RelativeAge.Now -> stringResource(R.string.time_now)
    is io.rivethub.app.plane.RelativeAge.Minutes -> stringResource(R.string.time_minutes, age.n)
    is io.rivethub.app.plane.RelativeAge.Hours -> stringResource(R.string.time_hours, age.n)
    is io.rivethub.app.plane.RelativeAge.Days -> stringResource(R.string.time_days, age.n)
    is io.rivethub.app.plane.RelativeAge.Weeks -> stringResource(R.string.time_weeks, age.n)
}

internal fun AccentToken.color(c: RivetColors) = when (this) {
    AccentToken.Em -> c.em
    AccentToken.Link -> c.link
    AccentToken.Warn -> c.warn
    AccentToken.Red -> c.red
    AccentToken.InkDim -> c.inkDim
}

@Composable
internal fun TopIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier.size(Dimens.touchTarget).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = RivetTheme.colors.ink, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun InboxSheet(items: List<HubViewModel.InboxItem>, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = colors.panel,
        contentColor = colors.ink,
        tonalElevation = 0.dp,
    ) {
        Text(
            stringResource(R.string.inbox_title),
            color = colors.ink,
            style = RivetType.title,
            modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
        )
        if (items.isEmpty()) {
            Text(
                stringResource(R.string.empty_inbox),
                color = colors.inkDim,
                style = RivetType.meta,
                modifier = Modifier.padding(Dimens.grid2),
            )
        } else {
            items.forEach { item ->
                Text(item.text, color = colors.ink, style = RivetType.body, modifier = Modifier.padding(Dimens.grid2))
            }
        }
        Spacer(Modifier.height(Dimens.grid2))
    }
}

@Composable
private fun RenameDialog(
    title: String,
    value: String,
    onValue: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.panel,
        title = { Text(title, color = colors.ink, style = RivetType.title) },
        text = {
            RivetField(value = value, onValueChange = onValue, placeholder = stringResource(R.string.rename_hint))
        },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onSave) {
                Text(stringResource(R.string.action_save), color = colors.em, style = RivetType.meta)
            }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel), color = colors.inkDim, style = RivetType.meta)
            }
        },
    )
}
