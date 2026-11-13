package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.OutboundItem
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Mid-turn outbound queue: dimmed text + inject / cancel, no card chrome.
 * Desktop `queued-strip.tsx` at 412 px.
 */
@Composable
fun QueuedStrip(
    items: List<OutboundItem>,
    onInject: (String) -> Unit,
    onCancel: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val queued = items.filter { it.status == OutboundItem.Status.QUEUED }
    if (queued.isEmpty()) return
    val colors = RivetTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        queued.forEach { item ->
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    item.text,
                    color = colors.inkDim,
                    style = RivetType.sm,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                RivetButton(
                    text = stringResource(R.string.queued_inject),
                    onClick = { onInject(item.id) },
                    variant = RivetButtonVariant.Ghost,
                    size = RivetButtonSize.Sm,
                )
                RivetButton(
                    text = stringResource(R.string.queued_cancel),
                    onClick = { onCancel(item.id) },
                    variant = RivetButtonVariant.Ghost,
                    size = RivetButtonSize.Sm,
                )
            }
        }
    }
}

/**
 * Who holds the session, when it is the terminal (plane/SessionDriver.kt,
 * rh contract note 79), and the chat messages rh holds for it. Read-only:
 * rh runs them when the terminal's turn ends.
 */
@Composable
fun DriverStripView(driver: io.rivethub.app.plane.DriverState?, modifier: Modifier = Modifier) {
    val strip = io.rivethub.app.plane.driverStrip(driver)
    val waiting = driver?.queued.orEmpty()
    if (strip == null && waiting.isEmpty()) return
    val colors = RivetTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (strip != null) {
            Text(
                stringResource(
                    when (strip) {
                        io.rivethub.app.plane.DriverStrip.TerminalWorking -> R.string.driver_terminal_working
                        io.rivethub.app.plane.DriverStrip.TerminalIdle -> R.string.driver_terminal_idle
                    },
                ),
                color = colors.inkDim,
                style = RivetType.xs,
            )
        }
        waiting.forEach { text ->
            Text(
                stringResource(R.string.driver_waiting, text),
                color = colors.inkDim,
                style = RivetType.xs,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
