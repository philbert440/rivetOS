package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import io.rivethub.app.plane.ContextBarView
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop `context-bar.tsx`: 96×6dp track, fill em (red ≥ 85%), caption mono 10sp. */
@Composable
fun ContextBar(
    view: ContextBarView,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val fill = if (view.hot) colors.red else colors.em
    Row(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(96.dp)
                .height(6.dp)
                .clip(RoundedCornerShape(Radius.full))
                .background(colors.panel2),
        ) {
            Box(
                Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(view.pct / 100f)
                    .clip(RoundedCornerShape(Radius.full))
                    .background(fill),
            )
        }
        Text(
            view.caption,
            color = colors.inkDim,
            style = RivetType.mono10,
            maxLines = 1,
        )
    }
}
