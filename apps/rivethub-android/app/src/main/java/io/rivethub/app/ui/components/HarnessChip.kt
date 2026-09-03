package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop conversation-row harness pill: `rounded bg-panel-2 px-1 mono 9sp inkDim`. */
@Composable
fun HarnessChip(text: String, modifier: Modifier = Modifier) {
    if (text.isBlank()) return
    val colors = RivetTheme.colors
    Text(
        text,
        color = colors.inkDim,
        style = RivetType.mono9,
        maxLines = 1,
        modifier = modifier
            .background(colors.panel2, RoundedCornerShape(Radius.sm))
            .padding(horizontal = 4.dp),
    )
}
