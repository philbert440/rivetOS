package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun ListRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    meta: @Composable RowScope.() -> Unit = {},
    trailing: @Composable () -> Unit = {},
    accent: Color? = null,
    dim: Boolean = false,
    pinned: Boolean = false,
    onLongClick: (() -> Unit)? = null,
) {
    val colors = RivetTheme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Dimens.rowMinHeight)
                .then(
                    if (onLongClick != null) {
                        Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick)
                    } else {
                        Modifier.clickable(onClick = onClick)
                    },
                )
                .padding(horizontal = Dimens.grid2, vertical = Dimens.gridHalf),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (accent != null) {
                Box(Modifier.size(Dimens.accentDot).clip(CircleShape).background(accent))
                Spacer(Modifier.width(Dimens.grid))
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (pinned) {
                        Icon(
                            Icons.Outlined.PushPin,
                            contentDescription = "Pinned",
                            tint = colors.em,
                            modifier = Modifier.size(12.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(
                        title,
                        color = if (dim) colors.inkDim else colors.ink,
                        style = RivetType.body,
                        maxLines = 1,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, content = meta)
            }
            trailing()
        }
        Box(Modifier.fillMaxWidth().height(Dimens.line).background(colors.line))
    }
}
