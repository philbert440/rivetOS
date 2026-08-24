package dev.rivetos.bots.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.domain.BlobShape
import dev.rivetos.bots.domain.BotLook
import dev.rivetos.bots.domain.BotLooks
import dev.rivetos.bots.ui.components.BlobAvatar
import dev.rivetos.bots.ui.components.VSpace

private data class Floater(val agent: String, val x: Float, val y: Float, val size: Int, val phase: Int)

private val floaters = listOf(
    Floater("pink", 0.52f, 0.10f, 46, 0),
    Floater("hermes", 0.18f, 0.20f, 58, 1),
    Floater("claude", 0.78f, 0.24f, 50, 2),
    Floater("grok", 0.12f, 0.36f, 44, 3),
    Floater("kimi", 0.80f, 0.56f, 52, 4),
    Floater("deepseek", 0.20f, 0.72f, 48, 5),
    Floater("opus", 0.66f, 0.84f, 44, 6),
)

/** First-run splash: floating bot faces, name, one inverted pill. */
@Composable
fun SignInScreen(onJoin: () -> Unit) {
    val t = rememberInfiniteTransition(label = "float")
    val drift by t.animateFloat(
        initialValue = -6f, targetValue = 6f,
        animationSpec = infiniteRepeatable(tween(2600), RepeatMode.Reverse), label = "drift",
    )
    val c = MaterialTheme.colorScheme
    BoxWithConstraints(Modifier.fillMaxSize().background(c.background)) {
        val w = maxWidth; val h = maxHeight
        floaters.forEach { f ->
            val dir = if (f.phase % 2 == 0) 1f else -1f
            BlobAvatar(
                if (f.agent == "pink") BotLook(0xFFF04E98, BlobShape.TRIANGLE) else BotLooks.forAgent(f.agent), f.size.dp,
                Modifier.offset(x = w * f.x - (f.size / 2).dp, y = h * f.y + (drift * dir).dp),
            )
        }
        Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Rivet Bots", color = c.onBackground, fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
            VSpace(8)
            Text(
                "Your mesh of always-on\nagents that finish the work.",
                color = c.onSurfaceVariant, fontSize = 15.sp, textAlign = TextAlign.Center, lineHeight = 20.sp,
            )
            VSpace(22)
            Button(
                onClick = onJoin,
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(containerColor = c.inverseSurface, contentColor = c.inverseOnSurface),
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text("Join mesh →", fontSize = 15.sp, fontWeight = FontWeight.Medium) }
        }
    }
}
