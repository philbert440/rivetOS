package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.data.BotEdit
import io.rivethub.app.data.Settings
import io.rivethub.app.data.effective
import io.rivethub.app.domain.BlobShape
import io.rivethub.app.domain.Bot
import io.rivethub.app.domain.BotLook
import io.rivethub.app.domain.BotLooks
import io.rivethub.app.ui.components.BlobAvatar
import io.rivethub.app.ui.components.CircleIconButton
import io.rivethub.app.ui.components.VSpace
import kotlinx.coroutines.launch

/** Six named-agent palette colours plus a few extras from [BotLooks]. */
private val EDIT_SWATCHES = listOf<Long>(
    0xFFF5822B, // orange
    0xFF2B2F36, // charcoal
    0xFF7C5CFF, // purple
    0xFF2BB5A0, // teal
    0xFF2F8CFF, // blue
    0xFF3DD68C, // green
    0xFFE5484D, // red
    0xFFF04E98, // pink
    0xFFF2C531, // yellow
)

@Composable
fun EditBotScreen(bot: Bot, settings: Settings, onBack: () -> Unit) {
    val prefs by settings.prefs.collectAsState(initial = null)
    val p = prefs ?: return
    val identity = remember(bot.agent) { BotLooks.forAgent(bot.agent) }
    val saved = p.botEdits[bot.id]
    var name by remember(bot.id) { mutableStateOf(saved?.name.orEmpty()) }
    var color by remember(bot.id) { mutableLongStateOf(bot.effective(saved).look.color) }
    var shape by remember(bot.id) { mutableStateOf(bot.effective(saved).look.shape) }
    val scope = rememberCoroutineScope()
    val cs = MaterialTheme.colorScheme
    val preview = bot.effective(
        BotEdit(name = name.trim().ifBlank { null }, color = color, shape = shape.name),
    )

    Column(
        Modifier.fillMaxSize().background(cs.background).systemBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
    ) {
        VSpace(8)
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircleIconButton(Icons.AutoMirrored.Filled.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text("Edit bot", color = cs.onBackground, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        }
        VSpace(24)
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            BlobAvatar(preview.look, 96.dp)
            VSpace(14)
            Text(preview.displayName, color = cs.onBackground, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
            Text("on ${bot.nodeLabel}", color = cs.onSurfaceVariant, fontSize = 14.sp)
        }
        VSpace(24)
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            singleLine = true,
            label = { Text("Name") },
            placeholder = { Text(bot.displayName) },
            modifier = Modifier.fillMaxWidth(),
        )
        VSpace(20)
        Text("Color", color = cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        VSpace(8)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val swatches = if (color in EDIT_SWATCHES) EDIT_SWATCHES else listOf(color) + EDIT_SWATCHES
            swatches.forEach { swatch ->
                val on = color == swatch
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .clickable { color = swatch }
                        .then(if (on) Modifier.border(2.dp, cs.onBackground, CircleShape) else Modifier)
                        .padding(6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(Color(swatch))
                            .border(1.dp, cs.outline, CircleShape),
                    )
                }
            }
        }
        VSpace(20)
        Text("Shape", color = cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        VSpace(8)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val shapes = if (shape in BlobShape.editable) BlobShape.editable else listOf(shape) + BlobShape.editable
            shapes.forEach { s ->
                val on = shape == s
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (on) cs.surfaceVariant else Color.Transparent)
                        .then(if (on) Modifier.border(2.dp, cs.onBackground, RoundedCornerShape(12.dp)) else Modifier)
                        .clickable { shape = s }
                        .padding(6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    BlobAvatar(BotLook(color, s), 36.dp, color = color, shape = s)
                }
            }
        }
        VSpace(28)
        Button(
            onClick = {
                val edit = BotEdit(
                    name = name.trim().takeIf { it.isNotEmpty() && it != bot.displayName },
                    color = color.takeIf { it != identity.color },
                    shape = shape.name.takeIf { shape != identity.shape },
                )
                scope.launch {
                    if (edit.name == null && edit.color == null && edit.shape == null) {
                        settings.clearBotEdit(bot.id)
                    } else {
                        settings.setBotEdit(bot.id, edit)
                    }
                    onBack()
                }
            },
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = cs.inverseSurface, contentColor = cs.inverseOnSurface),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("Save") }
        TextButton(
            onClick = {
                scope.launch {
                    settings.clearBotEdit(bot.id)
                    name = ""
                    color = identity.color
                    shape = identity.shape
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("Reset to default") }
        VSpace(32)
    }
}
