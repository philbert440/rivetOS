package io.rivethub.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun TopBar(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    subRow: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Dimens.touchTarget)
                .padding(end = Dimens.gridHalf),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(Dimens.touchTarget).then(
                    if (onBack != null) Modifier.clickable(role = Role.Button, onClick = onBack) else Modifier,
                ),
                contentAlignment = Alignment.Center,
            ) {
                if (onBack != null) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = colors.ink,
                        modifier = Modifier.size(22.dp),
                    )
                } else {
                    DenBotMark(28.dp)
                }
            }
            Text(
                title,
                color = colors.ink,
                style = RivetType.title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Row(verticalAlignment = Alignment.CenterVertically, content = actions)
        }
        subRow?.invoke()
        HorizontalDivider(thickness = Dimens.line, color = colors.line)
    }
}
