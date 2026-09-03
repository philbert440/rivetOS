package io.rivethub.app.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

sealed class ToolbarKey {
    abstract val id: String

    data class Label(override val id: String, val label: String) : ToolbarKey()

    data class IconAction(
        override val id: String,
        @DrawableRes val icon: Int,
        val contentDescription: String,
    ) : ToolbarKey()

    data class Sticky(override val id: String, val label: String) : ToolbarKey()
}

@Composable
fun KeyToolbar(
    keys: List<ToolbarKey>,
    onKey: (ToolbarKey) -> Unit,
    latched: Set<String> = emptySet(),
    onLongKey: ((ToolbarKey) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.8f))
            .drawBehind {
                val y = Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Dimens.grid, vertical = Dimens.gridHalf),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        keys.forEach { key ->
            val pressed = key is ToolbarKey.Sticky && key.id in latched
            Box(
                Modifier
                    .sizeIn(minWidth = Dimens.touchTarget, minHeight = Dimens.touchTarget)
                    .semantics {
                        role = Role.Button
                        if (key is ToolbarKey.IconAction) {
                            contentDescription = key.contentDescription
                        }
                    }
                    .combinedClickable(
                        role = Role.Button,
                        onClick = { onKey(key) },
                        onLongClick = onLongKey?.let { handler -> { handler(key) } },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .border(Dimens.line, if (pressed) colors.em else colors.line, shape)
                        .background(colors.panel2, shape)
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    when (key) {
                        is ToolbarKey.Label -> Text(
                            key.label,
                            color = colors.ink,
                            style = RivetType.mono11,
                        )
                        is ToolbarKey.Sticky -> Text(
                            key.label,
                            color = if (pressed) colors.em else colors.ink,
                            style = RivetType.mono11,
                        )
                        is ToolbarKey.IconAction -> Lucide(
                            key.icon,
                            contentDescription = null,
                            tint = colors.ink,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}
