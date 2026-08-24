package dev.rivetos.bots.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.ui.ComputerViewModel
import dev.rivetos.bots.ui.components.BotPill
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.PulsingDot
import dev.rivetos.bots.ui.components.VSpace
import dev.rivetos.bots.ui.theme.Dark
import dev.rivetos.bots.ui.theme.DarkDim
import dev.rivetos.bots.ui.theme.DarkInk
import dev.rivetos.bots.ui.theme.DarkPanel
import dev.rivetos.bots.ui.theme.Emerald

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

/** Grok Bot's "Computer" tab, Rivet-style: the bot's den room rendered natively. */
@Composable
fun ComputerScreen(vm: ComputerViewModel, bot: Bot, onBack: () -> Unit, onProfile: () -> Unit) {
    val s by vm.state.collectAsState()
    val room = s.room
    Column(Modifier.fillMaxSize().background(Dark).systemBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack, background = DarkPanel, tint = DarkInk)
            Spacer(Modifier.width(10.dp))
            BotPill(bot, onClick = onProfile, dark = true)
            Spacer(Modifier.weight(1f))
            if (s.ws == WsStatus.OPEN) PulsingDot(Emerald, 8) else Text("reconnecting…", color = DarkDim, fontSize = 11.sp)
        }

        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            VSpace(8)
            // The "screen": bezel card with the current pose front and centre.
            Column(
                Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(14.dp)).background(DarkPanel).padding(16.dp),
            ) {
                Text(
                    room?.title?.ifBlank { null } ?: "${bot.displayName} on ${bot.nodeLabel}",
                    color = DarkDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.weight(1f))
                if (s.error != null) {
                    Text("Can't reach the computer: ${s.error}", color = Color(0xFFF08A8E), fontSize = 14.sp, lineHeight = 19.sp)
                } else if (room == null) {
                    Text(
                        if (s.loaded) "Nothing on screen yet.\nSend ${bot.displayName} a message." else "Connecting…",
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
}
