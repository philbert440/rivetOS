package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Shape
import io.rivethub.app.ui.theme.RivetTheme

/**
 * Visual switch. [interactive] is false when a parent row owns the
 * toggle action, so TalkBack gets one labeled switch instead of a nameless one.
 */
@Composable
fun RivetToggle(
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    interactive: Boolean = true,
) {
    val colors = RivetTheme.colors
    val trackShape = RoundedCornerShape(Shape.row)
    val toggle = if (interactive) {
        Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onChange)
    } else {
        Modifier
    }
    Box(
        modifier
            .size(Dimens.toggleTrackW, Dimens.toggleTrackH)
            .clip(trackShape)
            .background(if (checked) colors.em else colors.bg)
            .border(Dimens.line, if (checked) colors.em else colors.line, trackShape)
            .then(toggle),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .offset(x = if (checked) 18.dp else 2.dp)
                .size(Dimens.toggleKnob)
                .clip(CircleShape)
                .background(colors.panel),
        )
    }
}
