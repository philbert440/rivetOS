package dev.rivetos.bots.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.data.RoomState
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.ui.ComputerTab
import dev.rivetos.bots.ui.ComputerViewModel
import dev.rivetos.bots.ui.TermAttach
import dev.rivetos.bots.ui.components.BotPill
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.DesktopView
import dev.rivetos.bots.ui.components.PulsingDot
import dev.rivetos.bots.ui.components.TerminalView
import dev.rivetos.bots.ui.components.VSpace
import dev.rivetos.bots.ui.theme.Dark
import dev.rivetos.bots.ui.theme.DarkDim
import dev.rivetos.bots.ui.theme.DarkInk
import dev.rivetos.bots.ui.theme.DarkPanel
import dev.rivetos.bots.ui.theme.Emerald

private const val DESKTOP_PLACEHOLDER = "http://192.0.2.30:6080/vnc.html"

private fun activityLabel(a: String): String = when (a) {
    "idle" -> "Idle"
    "thinking" -> "Thinking"
    "searching_web" -> "Searching the web"
    "editing_code" -> "Editing code"
    "running_command" -> "Running a command"
    "writing_plan" -> "Writing a plan"
    "listening" -> "Listening"
    "speaking" -> "Replying"
    "sleeping" -> "Asleep"
    else -> a.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** Grok Bot's "Computer" tab: Activity (den room), Terminal (PTY), Desktop (noVNC). */
@Composable
fun ComputerScreen(vm: ComputerViewModel, bot: Bot, onBack: () -> Unit, onProfile: () -> Unit) {
    val s by vm.state.collectAsState()
    Column(Modifier.fillMaxSize().background(Dark).systemBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, background = DarkPanel, tint = DarkInk)
            Spacer(Modifier.width(10.dp))
            BotPill(bot, onClick = onProfile, dark = true)
            Spacer(Modifier.weight(1f))
            HeaderStatus(s.tab, s.ws, s.termStatus)
        }
        TabStrip(s.tab, onSelect = vm::selectTab)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // Desktop WebView stays composed at full size so noVNC survives tab switches.
            if (s.desktopUrl.isNotBlank()) {
                DesktopView(s.desktopUrl, Modifier.fillMaxSize())
            }
            when (s.tab) {
                ComputerTab.Activity -> ActivityPane(s.room, s.loaded, s.error, bot)
                ComputerTab.Terminal -> TerminalPane(vm, s.termStatus, s.termError, s.termRev)
                ComputerTab.Desktop -> {
                    if (s.desktopUrl.isBlank()) SetDesktopUrl(onSave = vm::setDesktopUrl)
                }
            }
        }
    }
}

@Composable
private fun HeaderStatus(tab: ComputerTab, denWs: WsStatus, term: TermAttach) {
    when (tab) {
        ComputerTab.Activity -> if (denWs == WsStatus.OPEN) PulsingDot(Emerald, 8) else Text("reconnecting…", color = DarkDim, fontSize = 11.sp)
        ComputerTab.Terminal -> {
            val label = when (term) {
                TermAttach.Attached -> null
                TermAttach.Connecting, TermAttach.Idle -> "connecting…"
                TermAttach.Exited -> "exited"
                TermAttach.Closed -> "closed"
                TermAttach.Disabled -> "disabled"
                TermAttach.Error -> "error"
            }
            if (label == null) PulsingDot(Emerald, 8) else Text(label, color = DarkDim, fontSize = 11.sp)
        }
        ComputerTab.Desktop -> {}
    }
}

@Composable
private fun TabStrip(selected: ComputerTab, onSelect: (ComputerTab) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        ComputerTab.entries.forEach { tab ->
            val on = tab == selected
            Text(
                tab.name,
                color = if (on) DarkInk else DarkDim,
                fontSize = 13.sp,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(16.dp))
                    .background(if (on) DarkPanel else Color.Transparent)
                    .clickable { onSelect(tab) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun ActivityPane(room: RoomState?, loaded: Boolean, error: String?, bot: Bot) {
    Column(Modifier.fillMaxSize().background(Dark).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        VSpace(8)
        Column(
            Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(14.dp)).background(DarkPanel).padding(16.dp),
        ) {
            Text(
                room?.title?.ifBlank { null } ?: "${bot.displayName} on ${bot.nodeLabel}",
                color = DarkDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            if (error != null) {
                Text("Can't reach the computer: $error", color = Color(0xFFF08A8E), fontSize = 14.sp, lineHeight = 19.sp)
            } else if (room == null) {
                Text(
                    if (loaded) "Nothing on screen yet.\nSend ${bot.displayName} a message." else "Connecting…",
                    color = DarkDim, fontSize = 15.sp, lineHeight = 20.sp,
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (room.activity != "idle" && room.activity != "sleeping" && !room.ended) PulsingDot(Emerald, 10)
                    else Box(Modifier.size(10.dp).clip(CircleShape).background(DarkDim))
                    Spacer(Modifier.width(10.dp))
                    Text(
                        if (room.ended) "Session ended" else activityLabel(room.activity),
                        color = DarkInk, fontSize = 22.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                room.tool?.let { Text(it, color = Emerald, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(top = 4.dp)) }
                if (room.thought.isNotBlank()) {
                    Text(
                        room.thought, color = DarkDim, fontSize = 13.sp, fontStyle = FontStyle.Italic,
                        maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
            Spacer(Modifier.weight(1f))
        }

        if (room != null) {
            if (room.tasks.isNotEmpty()) {
                VSpace(20)
                Text("Plan", color = DarkDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                VSpace(8)
                room.tasks.forEach { t ->
                    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(18.dp).clip(CircleShape).background(if (t.done) Emerald else DarkPanel),
                            contentAlignment = Alignment.Center,
                        ) { if (t.done) Icon(Icons.Default.Check, null, tint = Dark, modifier = Modifier.size(12.dp)) }
                        Spacer(Modifier.width(10.dp))
                        Text(t.label, color = if (t.done) DarkDim else DarkInk, fontSize = 14.sp)
                    }
                }
            }
            if (room.term.isNotEmpty()) {
                VSpace(20)
                Text("Terminal", color = DarkDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                VSpace(8)
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color.Black).padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    room.term.takeLast(8).forEach { line ->
                        Text(line, color = Emerald, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (room.lastMessage.isNotBlank()) {
                VSpace(20)
                Text("Last said", color = DarkDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                VSpace(8)
                Text(room.lastMessage, color = DarkInk, fontSize = 14.sp, lineHeight = 19.sp, maxLines = 6, overflow = TextOverflow.Ellipsis)
            }
        }
        VSpace(32)
    }
}

@Composable
private fun TerminalPane(vm: ComputerViewModel, status: TermAttach, error: String?, rev: Int) {
    Column(Modifier.fillMaxSize().background(Dark)) {
        if (status == TermAttach.Error || status == TermAttach.Disabled || status == TermAttach.Closed) {
            Text(
                error ?: if (status == TermAttach.Closed) "Disconnected" else "Terminal unavailable",
                color = Color(0xFFF08A8E),
                fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            if (status != TermAttach.Disabled) {
                Text(
                    "Retry",
                    color = Emerald,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 16.dp).clickable { vm.retryTerm() },
                )
            }
        }
        TerminalView(vm, status, error, rev, Modifier.weight(1f).fillMaxWidth())
    }
}

@Composable
private fun SetDesktopUrl(onSave: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().background(Dark).padding(20.dp)) {
        Text("Set desktop URL", color = DarkInk, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        VSpace(8)
        Text(
            "The household noVNC desktop. Saved on this device; used for every bot.",
            color = DarkDim, fontSize = 13.sp, lineHeight = 18.sp,
        )
        VSpace(16)
        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(DarkPanel).padding(12.dp)) {
            if (draft.isBlank()) {
                Text(DESKTOP_PLACEHOLDER, color = DarkDim, fontSize = 14.sp)
            }
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                textStyle = TextStyle(color = DarkInk, fontSize = 14.sp),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        VSpace(16)
        Text(
            "Save",
            color = Emerald,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(DarkPanel)
                .clickable {
                    val raw = draft.trim()
                    if (raw.isNotBlank()) onSave(normalizeDesktopUrl(raw))
                }
                .padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

private fun normalizeDesktopUrl(raw: String): String {
    val t = raw.trim()
    return if (t.startsWith("http://") || t.startsWith("https://")) t else "http://$t"
}
