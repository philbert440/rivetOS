package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.ContextBarView
import androidx.compose.ui.draw.alpha
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Session chrome: back + canonical id, context bar, optional Stop,
 * Terminal | Chat. Wraps like the phone web header.
 */
@Composable
fun ChatSessionHeader(
    sessionLabel: String,
    context: ContextBarView?,
    modeOptions: List<String>,
    selectedMode: String,
    onSelectMode: (String) -> Unit,
    onBack: () -> Unit,
    showStop: Boolean,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    FlowRow(
        modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.4f))
            .drawBehind {
                val y = size.height - Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            val back = stringResource(R.string.action_back)
            Box(
                Modifier
                    .size(Dimens.touchTarget)
                    .semantics {
                        contentDescription = back
                        role = Role.Button
                    }
                    .clickable(role = Role.Button, onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Lucide(
                    R.drawable.lucide_arrow_left,
                    contentDescription = null,
                    tint = colors.inkDim,
                    modifier = Modifier.size(16.dp),
                )
            }
            Text(
                sessionLabel,
                color = colors.inkDim,
                style = RivetType.xs.copy(fontFamily = RivetFonts.Mono),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (context != null) {
            ContextBar(view = context)
        }
        if (showStop) {
            HeaderStopButton(onClick = onStop)
        }
        SegmentedControl(
            options = modeOptions,
            selected = selectedMode,
            onSelect = onSelectMode,
        )
    }
}

@Composable
private fun HeaderStopButton(onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val border = if (pressed) colors.red else colors.line
    val fg = if (pressed) colors.red else colors.inkDim
    val shape = RoundedCornerShape(Radius.sm)
    Row(
        Modifier
            .border(Dimens.line, border, shape)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Lucide(
            R.drawable.lucide_square,
            contentDescription = null,
            tint = fg,
            modifier = Modifier.size(10.dp),
        )
        Text(
            stringResource(R.string.action_stop),
            color = fg,
            style = RivetType.mono11,
        )
    }
}

@Composable
fun ChatStatusStrip(
    text: String,
    error: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Text(
        text,
        color = if (error) colors.red else colors.inkDim,
        style = RivetType.mono11,
        modifier = modifier
            .fillMaxWidth()
            .background(colors.panel2.copy(alpha = 0.4f))
            .drawBehind {
                val y = Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

@Composable
fun ChatEmptyState(modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    Column(
        modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        DenBot(size = 64.dp, modifier = Modifier.alpha(0.9f), decorative = true)
        Text(
            stringResource(R.string.empty_pick_conversation),
            color = colors.inkDim,
            style = RivetType.sm,
        )
    }
}

@Composable
fun TerminalRetryState(message: String, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    Column(
        modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(message, color = colors.red, style = RivetType.mono14)
        Text(
            stringResource(R.string.tap_terminal_retry),
            color = colors.inkDim,
            style = RivetType.xs,
        )
    }
}
