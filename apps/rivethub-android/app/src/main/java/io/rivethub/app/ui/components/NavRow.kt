package io.rivethub.app.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop sidebar `navClass`: `px-3 py-2 text-sm`, active `bg-panel-2 text-em`. */
@Composable
fun NavRow(
    label: String,
    @DrawableRes icon: Int,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    comingSoon: String? = null,
) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fg = when {
        !enabled -> colors.inkDim
        active -> colors.em
        pressed -> colors.ink
        else -> colors.inkDim
    }
    val bg = when {
        active -> colors.panel2
        pressed && enabled -> colors.panel2
        else -> androidx.compose.ui.graphics.Color.Transparent
    }
    Row(
        modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(RoundedCornerShape(Radius.sm))
            .background(bg)
            .then(
                if (comingSoon != null) Modifier.semantics { contentDescription = comingSoon }
                else Modifier,
            )
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Lucide(icon, contentDescription = null, tint = fg, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, color = fg, style = RivetType.sm, maxLines = 1)
    }
}
