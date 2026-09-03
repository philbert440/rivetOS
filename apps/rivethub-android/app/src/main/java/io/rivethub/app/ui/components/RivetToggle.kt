package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme

@Composable
fun RivetToggle(
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val trackShape = RoundedCornerShape(Dimens.radiusPill)
    Box(
        modifier
            .size(Dimens.toggleTrackW, Dimens.toggleTrackH)
            .clip(trackShape)
            .background(if (checked) colors.em else colors.bg)
            .border(Dimens.line, if (checked) colors.em else colors.line, trackShape)
            .clickable(role = Role.Switch, onClick = { onChange(!checked) }),
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
