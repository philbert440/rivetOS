package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
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

/**
 * Settings tab row — rivethub-web `pages/settings.tsx` narrow layout (a
 * horizontally scrolling row of tabs above the content). Square chips per the
 * Omarchy shape rule: the active tab is `emContainer` + `onEmContainer`, the rest `inkDim`.
 */
@Composable
fun SettingsTabRow(
    labels: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        labels.forEachIndexed { i, label ->
            val active = i == selected
            Box(
                Modifier
                    .sizeIn(minHeight = Dimens.touchTarget)
                    .then(if (active) Modifier.background(colors.emContainer) else Modifier)
                    .semantics {
                        this.selected = active
                    }
                    .clickable(role = Role.Tab) { onSelect(i) }
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (active) colors.onEmContainer else colors.inkDim, style = RivetType.sm)
            }
        }
    }
}
