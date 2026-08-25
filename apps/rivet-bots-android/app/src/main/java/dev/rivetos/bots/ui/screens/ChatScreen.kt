package dev.rivetos.bots.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Monitor
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.data.SessionMessage
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.data.visibleAssistantText
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.ui.ChatViewModel
import dev.rivetos.bots.ui.components.BotPill
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.PulsingDot
import dev.rivetos.bots.ui.components.TimeFmt

@Composable
fun ChatScreen(
    vm: ChatViewModel,
    bot: Bot,
    onBack: () -> Unit,
    onProfile: () -> Unit,
    onComputer: () -> Unit,
) {
    val s by vm.state.collectAsState()
    var draft by remember(s.sessionId) { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    val cs = MaterialTheme.colorScheme

    // Bottom-anchored list (reverseLayout: newest row is index 0), so a keyboard
    // opening keeps the tail in view by construction. `stick` follows new rows
    // and is released only by a user drag away from the bottom; sending re-arms it.
    var stick by remember(s.sessionId) { mutableStateOf(true) }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to (list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) }
            .collect { (dragging, atBottom) -> if (dragging) stick = atBottom else if (atBottom) stick = true }
    }
    val rowKey = s.messages.lastOrNull()?.id
    LaunchedEffect(rowKey, s.messages.size, s.pendingText.length, s.working, s.error, s.loading) {
        if (stick && !s.loading) list.scrollToItem(0)
    }

    Column(Modifier.fillMaxSize().background(cs.background).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(10.dp))
            BotPill(bot, onClick = onProfile)
            Spacer(Modifier.weight(1f))
            CircleIconButton(Icons.Default.Monitor, "Computer", onComputer)
            Spacer(Modifier.width(8.dp))
            Box {
                CircleIconButton(Icons.Default.MoreVert, "More", { menu = true })
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("New conversation") }, onClick = { menu = false; vm.newConversation() })
                    DropdownMenuItem(text = { Text("Bot profile") }, onClick = { menu = false; onProfile() })
                }
            }
        }

        LazyColumn(
            state = list,
            reverseLayout = true,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        ) {
            // Index 0 is the bottom of the screen: transient rows first, then messages newest→oldest.
            if (s.ws != WsStatus.OPEN && !s.loading) {
                item(key = "ws") {
                    Text(
                        if (s.ws == WsStatus.CONNECTING) "Connecting…" else "Reconnecting to ${bot.nodeLabel}…",
                        color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        textAlign = TextAlign.Center,
                    )
                }
            }
            s.error?.let { err ->
                item(key = "error") {
                    Text(err, color = cs.error, fontSize = 12.sp, modifier = Modifier.padding(vertical = 6.dp).clickable { vm.clearError() })
                }
            }
            if (s.working != null) {
                item(key = "working") {
                    Row(
                        Modifier.padding(vertical = 6.dp).clip(CircleShape).background(cs.surfaceVariant).padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        PulsingDot()
                        Spacer(Modifier.width(8.dp))
                        Text(s.working ?: "", color = cs.onSurfaceVariant, fontSize = 13.sp)
                    }
                }
            }
            if (s.pendingText.isNotEmpty()) {
                item(key = "pending") { Bubble(SessionMessage(id = "pending", role = "assistant", text = s.pendingText, ts = 0)) }
            }
            if (s.messages.isEmpty() && s.pendingText.isEmpty() && s.working == null && s.error == null && !s.loading) {
                item(key = "empty") {
                    Text(
                        "Say hello to ${bot.displayName}.",
                        color = cs.onSurfaceVariant, fontSize = 14.sp,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp), textAlign = TextAlign.Center,
                    )
                }
            }
            val msgs = s.messages
            itemsIndexed(msgs.asReversed(), key = { _, m -> m.id }) { rev, m ->
                val i = msgs.size - 1 - rev
                val prev = msgs.getOrNull(i - 1)
                val showDivider = prev == null || m.ts - prev.ts > 30 * 60_000L
                // Reversed layout draws children bottom-up, so the divider sits above its bubble.
                Column {
                    if (showDivider && m.ts > 0) {
                        Text(
                            TimeFmt.divider(m.ts), color = cs.onSurfaceVariant, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), textAlign = TextAlign.Center,
                        )
                    }
                    Bubble(m)
                }
            }
            item { Spacer(Modifier.height(4.dp)) }
        }

        Composer(
            placeholder = "Ask ${bot.displayName}",
            value = draft,
            onValue = { draft = it },
            onSend = { val t = draft; draft = ""; stick = true; vm.send(t) },
            canSend = s.canSend,
            onNewConversation = { vm.newConversation() },
            onComputer = onComputer,
        )
    }
}

@Composable
private fun Bubble(m: SessionMessage) {
    val cs = MaterialTheme.colorScheme
    val user = m.role == "user"
    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        Surface(
            color = if (user) cs.inverseSurface else cs.surfaceVariant,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            Text(
                (if (user) m.text else visibleAssistantText(m.text)).ifBlank { if (user) "" else "…" },
                color = if (user) cs.inverseOnSurface else cs.onSurface,
                fontSize = 16.sp, lineHeight = 21.sp,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            )
        }
        val tools = m.tools.orEmpty()
        if (!user && tools.isNotEmpty()) {
            Row(Modifier.padding(top = 4.dp, start = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                tools.map { it.name.substringAfterLast(':') }.distinct().take(5).forEach { name ->
                    Text(
                        name, color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                        modifier = Modifier.clip(CircleShape).background(cs.background).padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
                if (tools.size > 5) Text("+${tools.size - 5}", color = cs.onSurfaceVariant, fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun Composer(
    placeholder: String,
    value: String,
    onValue: (String) -> Unit,
    onSend: () -> Unit,
    onNewConversation: () -> Unit,
    onComputer: () -> Unit,
    canSend: Boolean,
) {
    val cs = MaterialTheme.colorScheme
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var plusMenu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            CircleIconButton(Icons.Default.Add, "Actions", { plusMenu = true }, background = cs.background, tint = cs.onSurface, size = 36)
            DropdownMenu(expanded = plusMenu, onDismissRequest = { plusMenu = false }) {
                DropdownMenuItem(text = { Text("New conversation") }, onClick = { plusMenu = false; onNewConversation() })
                DropdownMenuItem(text = { Text("Watch the computer") }, onClick = { plusMenu = false; onComputer() })
            }
        }
        Spacer(Modifier.width(8.dp))
        Row(
            Modifier.weight(1f).clip(CircleShape).background(cs.outline)
                .padding(1.dp).clip(CircleShape).background(cs.surfaceVariant)
                .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = value, onValueChange = onValue, maxLines = 5,
                textStyle = TextStyle(color = cs.onSurface, fontSize = 16.sp),
                modifier = Modifier.weight(1f).padding(vertical = 6.dp),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text(placeholder, color = cs.onSurfaceVariant, fontSize = 16.sp)
                    inner()
                },
            )
            Spacer(Modifier.width(6.dp))
            if (value.isBlank()) {
                Box(
                    Modifier
                        .minimumInteractiveComponentSize()
                        .clip(CircleShape)
                        .clickable {
                            android.widget.Toast.makeText(ctx, "Dictation isn't wired up yet", android.widget.Toast.LENGTH_SHORT).show()
                        }
                        .padding(8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.Mic, "Voice", tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
                }
            } else {
                CircleIconButton(
                    Icons.Default.ArrowUpward, if (canSend) "Send" else "Waiting for reply",
                    { if (canSend) onSend() }, background = if (canSend) cs.inverseSurface else cs.onSurfaceVariant, tint = cs.inverseOnSurface, size = 30,
                )
            }
        }
    }
}
