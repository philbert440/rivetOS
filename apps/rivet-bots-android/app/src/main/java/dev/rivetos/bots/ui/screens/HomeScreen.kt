package dev.rivetos.bots.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.domain.BotLooks
import dev.rivetos.bots.ui.HomeViewModel
import dev.rivetos.bots.ui.components.BlobAvatar
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.TimeFmt
import dev.rivetos.bots.ui.components.VSpace

/** Bot list — the Grok Bot home: header, pinned faces, then threads by recency. */
@Composable
fun HomeScreen(
    vm: HomeViewModel,
    onOpenChat: (Bot) -> Unit,
    onOpenProfile: (Bot) -> Unit,
    onSettings: () -> Unit,
) {
    val s by vm.state.collectAsState()
    var searching by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    var addNode by remember { mutableStateOf(false) }
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { if ((s.bots.isEmpty() || s.error != null) && !s.loading) vm.refresh() }

    Column(Modifier.fillMaxSize().background(cs.background).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .minimumInteractiveComponentSize()
                    .size(36.dp).clip(CircleShape).background(cs.inverseSurface).clickable(onClick = onSettings),
                contentAlignment = Alignment.Center,
            ) {
                Text(s.prefs.handle.take(1).uppercase(), color = cs.inverseOnSurface, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.weight(1f))
            CircleIconButton(if (searching) Icons.Default.Close else Icons.Default.Search, "Search", {
                searching = !searching; if (!searching) vm.setQuery("")
            })
            Spacer(Modifier.width(10.dp))
            CircleIconButton(Icons.Default.Add, "Add", { sheet = true })
        }
        AnimatedVisibility(searching) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                BasicTextField(
                    value = s.query, onValueChange = vm::setQuery, singleLine = true,
                    textStyle = TextStyle(color = cs.onSurface, fontSize = 15.sp),
                    modifier = Modifier.fillMaxWidth().clip(CircleShape).background(cs.surfaceVariant).padding(horizontal = 16.dp, vertical = 10.dp),
                    decorationBox = { inner ->
                        if (s.query.isEmpty()) Text("Search bots and messages", color = cs.onSurfaceVariant, fontSize = 15.sp)
                        inner()
                    },
                )
            }
        }

        PullToRefreshBox(isRefreshing = s.loading, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                s.error?.let { err ->
                    item {
                        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(err, color = cs.error, fontSize = 13.sp, textAlign = TextAlign.Center)
                            TextButton(onClick = vm::refresh) { Text("Retry") }
                        }
                    }
                }
                if (s.pinned.isNotEmpty()) {
                    item {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(18.dp),
                        ) {
                            items(s.pinned, key = { "pin-" + it.id }) { b ->
                                Column(
                                    Modifier.width(84.dp).combinedClickable(onClick = { onOpenChat(b) }, onLongClick = { onOpenProfile(b) }),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    BlobAvatar(BotLooks.forAgent(b.agent), 68.dp, dimmed = !b.online)
                                    VSpace(6)
                                    Text(b.displayName, color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
                if (s.loadedOnce && !s.loading && s.ordered.isEmpty() && s.error == null) {
                    item {
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                if (s.query.isBlank()) "No bots found on the mesh yet." else "No matches.",
                                color = cs.onSurfaceVariant, fontSize = 15.sp, textAlign = TextAlign.Center,
                            )
                            if (s.query.isBlank()) {
                                VSpace(6)
                                Text(
                                    "Pull down to rescan, or add a node from +.",
                                    color = cs.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center,
                                )
                            }
                        }
                    }
                }
                items(s.ordered, key = { it.id }) { b ->
                    BotRow(
                        bot = b,
                        preview = s.previews[b.id]?.text ?: if (b.online) "Say hello." else "Offline",
                        time = s.previews[b.id]?.ts?.let(TimeFmt::listTime) ?: "",
                        unread = s.unread(b),
                        pinned = b.id in s.prefs.pinned,
                        onClick = { onOpenChat(b) },
                        onLongClick = { onOpenProfile(b) },
                        onPin = { vm.togglePin(b) },
                        onHide = { vm.setHidden(b, true) },
                        modifier = Modifier.animateItem(),
                    )
                }
            }
        }
    }

    if (sheet) {
        ModalBottomSheet(onDismissRequest = { sheet = false }, containerColor = cs.surface) {
            ListItem(headlineContent = { Text("Rescan mesh") }, modifier = Modifier.clickable { sheet = false; vm.refresh() })
            ListItem(headlineContent = { Text("Add node by URL…") }, modifier = Modifier.clickable { sheet = false; addNode = true })
            if (s.prefs.hidden.isNotEmpty()) {
                ListItem(
                    headlineContent = { Text("Unhide ${s.prefs.hidden.size} hidden bot(s)") },
                    modifier = Modifier.clickable { sheet = false; vm.unhideAll() },
                )
            }
            VSpace(24)
        }
    }
    if (addNode) {
        var url by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { addNode = false },
            title = { Text("Add node") },
            text = {
                OutlinedTextField(
                    value = url, onValueChange = { url = it }, singleLine = true,
                    placeholder = { Text("https://192.0.2.20:5174") }, modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = { if (url.startsWith("https://")) { vm.addNode(url); addNode = false } }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { addNode = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun BotRow(
    bot: Bot,
    preview: String,
    time: String,
    unread: Boolean,
    pinned: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onPin: () -> Unit,
    onHide: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    val dismiss = rememberSwipeToDismissBoxState(
        confirmValueChange = { v ->
            when (v) {
                SwipeToDismissBoxValue.StartToEnd -> onPin()
                SwipeToDismissBoxValue.EndToStart -> onHide()
                else -> Unit
            }
            false
        },
    )
    SwipeToDismissBox(
        state = dismiss,
        modifier = modifier,
        backgroundContent = {
            val toEnd = dismiss.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            Row(
                Modifier.fillMaxSize().background(if (toEnd) cs.tertiary else cs.onSurfaceVariant).padding(horizontal = 24.dp),
                horizontalArrangement = if (toEnd) Arrangement.Start else Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (toEnd) Icons.Default.PushPin else Icons.Default.VisibilityOff, null, tint = cs.inverseOnSurface)
                Spacer(Modifier.width(8.dp))
                Text(if (toEnd) (if (pinned) "Unpin" else "Pin") else "Hide", color = cs.inverseOnSurface, fontWeight = FontWeight.Medium)
            }
        },
    ) {
        Row(
            Modifier.fillMaxWidth().background(cs.background)
                .combinedClickable(onClick = onClick, onLongClick = onLongClick)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BlobAvatar(BotLooks.forAgent(bot.agent), 46.dp, dimmed = !bot.online, online = bot.online)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(bot.displayName, color = cs.onBackground, fontSize = 16.sp, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold)
                    Spacer(Modifier.width(6.dp))
                    Text(bot.nodeLabel, color = cs.onSurfaceVariant, fontSize = 12.sp)
                    if (pinned) { Spacer(Modifier.width(4.dp)); Icon(Icons.Default.PushPin, "Pinned", tint = cs.onSurfaceVariant, modifier = Modifier.size(12.dp)) }
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    preview.replace('\n', ' '),
                    color = if (unread) cs.onBackground else cs.onSurfaceVariant, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(time, color = cs.onSurfaceVariant, fontSize = 12.sp)
                if (unread) { Spacer(Modifier.height(4.dp)); Box(Modifier.size(8.dp).clip(CircleShape).background(cs.tertiary)) }
            }
        }
    }
}
