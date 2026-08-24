package dev.rivetos.bots.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.domain.BotLooks
import dev.rivetos.bots.ui.components.BlobAvatar
import dev.rivetos.bots.ui.components.CircleIconButton
import dev.rivetos.bots.ui.components.VSpace

@Composable
fun ProfileScreen(
    bot: Bot,
    sessionId: String,
    pinned: Boolean,
    hidden: Boolean,
    onBack: () -> Unit,
    onMessage: () -> Unit,
    onComputer: () -> Unit,
    onTogglePin: () -> Unit,
    onToggleHide: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(cs.background).systemBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
        VSpace(8)
        CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
        VSpace(16)
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            BlobAvatar(BotLooks.forAgent(bot.agent), 96.dp, dimmed = !bot.online)
            VSpace(14)
            Text(bot.displayName, color = cs.onBackground, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
            Text("on ${bot.nodeLabel}", color = cs.onSurfaceVariant, fontSize = 14.sp)
            VSpace(10)
            Row(
                Modifier.background(cs.surfaceVariant, CircleShape).padding(horizontal = 12.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(if (bot.online) cs.tertiary else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(if (bot.online) "Online" else "Offline", color = cs.onSurface, fontSize = 13.sp)
            }
        }
        VSpace(24)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = onMessage, shape = CircleShape, modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                colors = ButtonDefaults.buttonColors(containerColor = cs.inverseSurface, contentColor = cs.inverseOnSurface),
            ) { Text("Message") }
            OutlinedButton(onClick = onComputer, shape = CircleShape, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Computer") }
        }
        VSpace(10)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = onTogglePin, shape = CircleShape, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(if (pinned) "Unpin" else "Pin") }
            OutlinedButton(onClick = onToggleHide, shape = CircleShape, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(if (hidden) "Unhide" else "Hide") }
        }
        VSpace(24)
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                Detail("Agent", bot.agent)
                Detail("Provider", bot.provider ?: "—")
                Detail("Model", bot.model ?: "—")
                Detail("Node", "${bot.nodeName} (${bot.nodeId})")
                Detail("Gateway", BotRepository.hostOf(bot.denUrl))
                Detail("Sessions", bot.nodeSessions?.toString() ?: "—")
                Detail("Thread", sessionId, mono = true)
            }
        }
        VSpace(16)
        Text(
            "Bots are agents running on RivetOS mesh nodes. Every message goes straight to this node's gateway, and the Computer view shows what it's doing right now.",
            color = cs.onSurfaceVariant, fontSize = 12.sp, lineHeight = 17.sp,
        )
        VSpace(32)
    }
}

@Composable
private fun Detail(k: String, v: String, mono: Boolean = false) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(k, color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.width(84.dp))
        Text(v, color = cs.onSurface, fontSize = 13.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default)
    }
}
