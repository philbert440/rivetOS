package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun StreamChip(text: String, modifier: Modifier = Modifier) {
    ChipFrame(modifier) {
        EmDot()
        Text(text, color = RivetTheme.colors.inkDim, style = RivetType.monoPill, maxLines = 1)
    }
}

@Composable
fun FoldChip(text: String, expanded: Boolean, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val colors = RivetTheme.colors
    ChipFrame(modifier.clickable(enabled = onClick != null, role = Role.Button, onClick = { onClick?.invoke() })) {
        EmDot()
        Text(text, color = colors.inkDim, style = RivetType.monoPill, maxLines = 1)
        Icon(
            if (expanded) Icons.Outlined.KeyboardArrowDown else Icons.Outlined.KeyboardArrowRight,
            contentDescription = if (expanded) "Collapse" else "Expand",
            tint = colors.inkDim,
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun ChipFrame(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius4)
    Row(
        modifier
            .border(Dimens.line, colors.line, shape)
            .background(colors.bg, shape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
private fun EmDot() {
    Box(
        Modifier
            .size(6.dp)
            .clip(CircleShape)
            .background(RivetTheme.colors.em),
    )
}
