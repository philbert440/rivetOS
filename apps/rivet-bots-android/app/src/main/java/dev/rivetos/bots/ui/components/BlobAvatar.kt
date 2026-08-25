package dev.rivetos.bots.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import dev.rivetos.bots.domain.BlobShape
import dev.rivetos.bots.domain.BotLook
import dev.rivetos.bots.ui.theme.Emerald
import dev.rivetos.bots.ui.theme.Paper

/**
 * A bot's face: a coloured silhouette with two white eye-marks, in the style
 * of the Grok Bot avatars. Deterministic per agent (see BotLooks). Silhouette
 * colours and the white eyes are identity and never follow the theme; only the
 * presence badge (page-coloured ring, grey offline dot) adapts.
 */
@Composable
fun BlobAvatar(
    look: BotLook,
    size: Dp,
    modifier: Modifier = Modifier,
    dimmed: Boolean = false,
    eyes: Boolean = true,
    online: Boolean? = null,
    color: Long? = null,
    shape: BlobShape? = null,
) {
    val resolved = look.copy(color = color ?: look.color, shape = shape ?: look.shape)
    val ring = MaterialTheme.colorScheme.background
    val offline = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val color = Color(resolved.color).let { if (dimmed) it.copy(alpha = 0.45f) else it }
        val path = blobPath(resolved.shape, w, h)
        drawPath(path, color)
        if (resolved.shape == BlobShape.TRIANGLE || resolved.shape == BlobShape.HEX) {
            // Soften the corners: a fat stroke with a corner effect over the fill.
            drawPath(
                path, color,
                style = Stroke(width = w * 0.10f, pathEffect = PathEffect.cornerPathEffect(w * 0.18f)),
            )
        }
        if (eyes) drawEyes(resolved.shape, w, h, if (dimmed) Paper.copy(alpha = 0.8f) else Paper)
        if (online != null) {
            val r = w * 0.14f
            val c = Offset(w - r * 1.1f, h - r * 1.1f)
            drawCircle(ring, r * 1.45f, c)
            drawCircle(if (online) Emerald else offline, r, c)
        }
    }
}

private fun DrawScope.drawEyes(shape: BlobShape, w: Float, h: Float, color: Color) {
    val ew = w * 0.10f
    val eh = h * 0.21f
    val cy = when (shape) {
        BlobShape.DROP -> h * 0.60f
        BlobShape.TRIANGLE -> h * 0.62f
        BlobShape.ARCH -> h * 0.50f
        BlobShape.CLOUD -> h * 0.54f
        else -> h * 0.44f
    }
    listOf(w * 0.40f to cy, w * 0.60f to cy - h * 0.02f).forEach { (cx, y) ->
        rotate(degrees = -12f, pivot = Offset(cx, y)) {
            drawRoundRect(
                color = color,
                topLeft = Offset(cx - ew / 2, y - eh / 2),
                size = Size(ew, eh),
                cornerRadius = CornerRadius(ew / 2, ew / 2),
            )
        }
    }
}

fun blobPath(shape: BlobShape, w: Float, h: Float): Path = Path().apply {
    when (shape) {
        BlobShape.CIRCLE -> addOval(Rect(0f, 0f, w, h))
        BlobShape.SQUIRCLE -> addRoundRect(
            androidx.compose.ui.geometry.RoundRect(
                Rect(w * 0.05f, h * 0.05f, w * 0.95f, h * 0.95f), CornerRadius(w * 0.32f, w * 0.32f),
            ),
        )
        BlobShape.EGG -> {
            moveTo(w * 0.5f, 0f)
            cubicTo(w * 0.90f, 0f, w * 1.00f, h * 0.45f, w * 0.96f, h * 0.64f)
            cubicTo(w * 0.90f, h * 0.98f, w * 0.10f, h * 0.98f, w * 0.04f, h * 0.64f)
            cubicTo(w * 0.00f, h * 0.45f, w * 0.10f, 0f, w * 0.5f, 0f)
            close()
        }
        BlobShape.DROP -> {
            moveTo(w * 0.5f, 0f)
            cubicTo(w * 0.56f, h * 0.22f, w * 1.0f, h * 0.40f, w * 1.0f, h * 0.64f)
            cubicTo(w * 1.0f, h * 0.86f, w * 0.78f, h * 1.0f, w * 0.5f, h * 1.0f)
            cubicTo(w * 0.22f, h * 1.0f, 0f, h * 0.86f, 0f, h * 0.64f)
            cubicTo(0f, h * 0.40f, w * 0.44f, h * 0.22f, w * 0.5f, 0f)
            close()
        }
        BlobShape.TRIANGLE -> {
            moveTo(w * 0.5f, h * 0.06f)
            lineTo(w * 0.94f, h * 0.90f)
            lineTo(w * 0.06f, h * 0.90f)
            close()
        }
        BlobShape.HEX -> {
            val cx = w / 2; val cy = h / 2; val r = w * 0.47f
            for (i in 0 until 6) {
                val a = Math.toRadians((60.0 * i) - 30.0)
                val x = (cx + r * Math.cos(a)).toFloat(); val y = (cy + r * Math.sin(a)).toFloat()
                if (i == 0) moveTo(x, y) else lineTo(x, y)
            }
            close()
        }
        BlobShape.ARCH -> {
            // Round top, softly rounded feet — drawn fully, no stroke pass needed.
            moveTo(w * 0.10f, h * 0.48f)
            cubicTo(w * 0.10f, h * 0.06f, w * 0.90f, h * 0.06f, w * 0.90f, h * 0.48f)
            lineTo(w * 0.90f, h * 0.88f)
            cubicTo(w * 0.90f, h * 0.94f, w * 0.86f, h * 0.97f, w * 0.80f, h * 0.97f)
            lineTo(w * 0.20f, h * 0.97f)
            cubicTo(w * 0.14f, h * 0.97f, w * 0.10f, h * 0.94f, w * 0.10f, h * 0.88f)
            close()
        }
        BlobShape.CLOUD -> {
            addOval(Rect(w * 0.02f, h * 0.36f, w * 0.56f, h * 0.90f))
            addOval(Rect(w * 0.44f, h * 0.36f, w * 0.98f, h * 0.90f))
            addOval(Rect(w * 0.20f, h * 0.10f, w * 0.80f, h * 0.70f))
            addRect(Rect(w * 0.28f, h * 0.55f, w * 0.72f, h * 0.90f))
        }
    }
}
