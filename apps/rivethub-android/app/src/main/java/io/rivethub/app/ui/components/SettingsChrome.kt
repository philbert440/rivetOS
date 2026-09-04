package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Settings section rhythm — settings.tsx:61/220/263: every `h2` is
 * `mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em`
 * (the divider spans the full content width; [first] drops the rule for the
 * lead section). [FieldLabel] is the `mb-1 text-xs text-ink-dim` field label.
 */
@Composable
fun SettingsH2(text: String, first: Boolean = false) {
    val colors = RivetTheme.colors
    Text(
        text,
        color = colors.em,
        style = RivetType.monoSmSemibold,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = if (first) 0.dp else 40.dp)
            .then(if (first) Modifier else Modifier.drawTopPad(colors.line))
            .padding(top = if (first) 0.dp else 24.dp)
            .padding(bottom = 12.dp),
    )
}

@Composable
fun FieldLabel(text: String) {
    Text(
        text,
        color = RivetTheme.colors.inkDim,
        style = RivetType.xs,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

private fun Modifier.drawTopPad(color: Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(
            color,
            Offset(0f, stroke / 2f),
            Offset(size.width, stroke / 2f),
            stroke,
        )
    }
