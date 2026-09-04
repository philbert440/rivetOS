package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

enum class RivetButtonVariant { Default, Ghost, Outline }
enum class RivetButtonSize { Default, Sm, Icon, IconXs }

/**
 * Desktop `ui/button.tsx`: `rounded-md`, `font-medium`, default / ghost / outline
 * × default / sm / icon / icon-xs. Visual height stays 36/32/24dp; the outer
 * box is a 44dp hit target.
 */
@Composable
fun RivetButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: RivetButtonVariant = RivetButtonVariant.Default,
    size: RivetButtonSize = RivetButtonSize.Default,
    enabled: Boolean = true,
    interactionSource: MutableInteractionSource = remember { MutableInteractionSource() },
    content: @Composable RowScope.() -> Unit,
) {
    val colors = RivetTheme.colors
    val pressed by interactionSource.collectIsPressedAsState()
    val shape = RoundedCornerShape(Radius.md)
    val height = when (size) {
        RivetButtonSize.Default, RivetButtonSize.Icon -> 36.dp
        RivetButtonSize.Sm -> 32.dp
        RivetButtonSize.IconXs -> 24.dp
    }
    val padding = when (size) {
        RivetButtonSize.Default -> PaddingValues(horizontal = 16.dp)
        RivetButtonSize.Sm -> PaddingValues(horizontal = 12.dp)
        RivetButtonSize.Icon, RivetButtonSize.IconXs -> PaddingValues(0.dp)
    }
    val iconBox = size == RivetButtonSize.Icon || size == RivetButtonSize.IconXs
    val bg: Color
    val border: Color?
    when (variant) {
        RivetButtonVariant.Default -> {
            bg = if (pressed) colors.em else colors.emDim
            border = null
        }
        RivetButtonVariant.Ghost -> {
            bg = if (pressed) colors.panel2 else Color.Transparent
            border = null
        }
        RivetButtonVariant.Outline -> {
            bg = colors.panel2
            border = if (pressed) colors.em.copy(alpha = 0.6f) else colors.line
        }
    }
    val sized = if (iconBox) Modifier.size(height) else Modifier.height(height)
    Box(
        modifier.sizeIn(minWidth = if (iconBox) 44.dp else 0.dp, minHeight = 44.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .then(sized)
                .alpha(if (enabled) 1f else 0.4f)
                .clip(shape)
                .background(bg, shape)
                .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
                .clickable(
                    interactionSource = interactionSource,
                    indication = null,
                    enabled = enabled,
                    role = Role.Button,
                    onClick = onClick,
                )
                .padding(padding),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}

@Composable
fun RivetButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: RivetButtonVariant = RivetButtonVariant.Default,
    size: RivetButtonSize = RivetButtonSize.Default,
    enabled: Boolean = true,
    textColor: Color? = null,
) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fg = when (variant) {
        RivetButtonVariant.Default -> textColor ?: colors.bg
        RivetButtonVariant.Ghost -> textColor ?: if (pressed) colors.ink else colors.inkDim
        RivetButtonVariant.Outline -> textColor ?: colors.ink
    }
    RivetButton(
        onClick = onClick,
        modifier = modifier,
        variant = variant,
        size = size,
        enabled = enabled,
        interactionSource = interaction,
    ) {
        Text(
            text,
            color = fg,
            style = RivetType.sm.copy(fontWeight = FontWeight.Medium),
            maxLines = 1,
        )
    }
}
