package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.ChatError
import io.rivethub.app.plane.showClearAll
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Error stack above the composer (UX-SPEC §1.2): one `panel` card per error,
 * newest at the bottom, a 2dp `red` rail on the leading edge, ✕ to dismiss,
 * and "Clear all" once more than one is up. Renders nothing when empty.
 */
@Composable
fun ChatErrorStack(
    errors: List<ChatError>,
    onDismiss: (Long) -> Unit,
    onClearAll: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (errors.isEmpty()) return
    val colors = RivetTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (showClearAll(errors)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Text(
                    stringResource(R.string.clear_all),
                    color = colors.inkDim,
                    style = RivetType.mono11,
                    modifier = Modifier
                        .sizeIn(minHeight = 28.dp)
                        .clip(RoundedCornerShape(Radius.sm))
                        .clickable(role = Role.Button, onClick = onClearAll)
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        errors.forEach { err -> ErrorCard(err, onDismiss = { onDismiss(err.id) }) }
    }
}

@Composable
private fun ErrorCard(err: ChatError, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.md)
    val rail = colors.red
    val dismiss = stringResource(R.string.dismiss)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel, shape)
            .drawBehind {
                val w = 2.dp.toPx()
                drawLine(rail, Offset(w / 2f, 0f), Offset(w / 2f, size.height), w)
            }
            .padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            err.text,
            color = colors.ink,
            style = RivetType.mono11,
            modifier = Modifier
                .weight(1f)
                .padding(vertical = 8.dp),
        )
        Box(
            Modifier
                .size(Dimens.touchTarget)
                .semantics {
                    contentDescription = dismiss
                    role = Role.Button
                }
                .clickable(role = Role.Button, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(R.drawable.lucide_x, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(14.dp))
        }
    }
}
