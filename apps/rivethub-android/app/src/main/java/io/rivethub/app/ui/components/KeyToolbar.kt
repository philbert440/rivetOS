package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme

sealed class ToolbarKey {
    abstract val id: String

    data class Label(override val id: String, val label: String) : ToolbarKey()

    data class IconAction(
        override val id: String,
        val icon: ImageVector,
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
    val shape = RoundedCornerShape(Dimens.radius6)
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.panel2)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Dimens.grid, vertical = Dimens.gridHalf),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        keys.forEach { key ->
            val pressed = key is ToolbarKey.Sticky && key.id in latched
            Box(
                Modifier
                    .height(Dimens.keyHeight)
                    .clip(shape)
                    .background(if (pressed) colors.panel2 else colors.panel, shape)
                    .border(Dimens.line, if (pressed) colors.em else colors.line, shape)
                    .combinedClickable(
                        role = Role.Button,
                        onClick = { onKey(key) },
                        onLongClick = onLongKey?.let { handler -> { handler(key) } },
                    )
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                when (key) {
                    is ToolbarKey.Label -> Text(
                        key.label,
                        color = colors.ink,
                        fontFamily = RivetFonts.Mono,
                        fontSize = 12.sp,
                    )
                    is ToolbarKey.Sticky -> Text(
                        key.label,
                        color = if (pressed) colors.em else colors.ink,
                        fontFamily = RivetFonts.Mono,
                        fontSize = 12.sp,
                    )
                    is ToolbarKey.IconAction -> Icon(
                        key.icon,
                        contentDescription = key.contentDescription,
                        tint = colors.ink,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}
