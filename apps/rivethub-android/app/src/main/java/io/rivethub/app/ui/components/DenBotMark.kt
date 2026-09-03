package io.rivethub.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import io.rivethub.app.ui.theme.RivetTheme

/** Stroke logo: rounded rect + two eyes + antenna, `em` stroke. */
@Composable
fun DenBotMark(size: Dp, modifier: Modifier = Modifier) {
    val color = RivetTheme.colors.em
    Canvas(modifier.size(size).semantics { contentDescription = "Rivet" }) {
        val w = this.size.width
        val strokeW = w * 0.08f
        val stroke = Stroke(width = strokeW, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val left = w * 0.18f
        val right = w * 0.82f
        val top = w * 0.32f
        val bottom = w * 0.88f
        val radius = w * 0.16f
        drawRoundRect(
            color = color,
            topLeft = Offset(left, top),
            size = Size(right - left, bottom - top),
            cornerRadius = CornerRadius(radius, radius),
            style = stroke,
        )
        val eyeY = top + (bottom - top) * 0.38f
        val eyeR = w * 0.055f
        drawCircle(color, eyeR, Offset(w * 0.38f, eyeY))
        drawCircle(color, eyeR, Offset(w * 0.62f, eyeY))
        val antX = w * 0.5f
        drawLine(
            color = color,
            start = Offset(antX, top),
            end = Offset(antX, w * 0.12f),
            strokeWidth = strokeW,
            cap = StrokeCap.Round,
        )
        drawCircle(color, w * 0.07f, Offset(antX, w * 0.10f), style = stroke)
    }
}
