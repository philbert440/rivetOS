package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
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
import io.rivethub.app.plane.NarrowHeaderItem
import io.rivethub.app.plane.narrowHeaderItems
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Session chrome — ONE 48dp row that OWNS the status-bar inset (web narrow
 * branch, chat.tsx:1645-1674): ☰ · session id (flex-1, truncates) · ctx % ·
 * Stop (interruptible turn only) · Terminal|Chat · history. No back chevron —
 * on the phone "back" is the right-side history drawer (Phil 2026-09-03), and
 * the wordmark TopBar is not shown while a session is open.
 *
 * Tokens mirror the desktop header: `border-b border-line bg-panel/40 px-2
 * gap-2` (chat.tsx:1645), mono `text-xs text-ink-dim` title (chat.tsx:1659),
 * 44dp hit boxes with 20dp (`size-5`) lucide icons. Item order and visibility
 * come from `narrowHeaderItems` (plane/ChatChrome.kt), mirroring
 * lib/session-header.ts. `padStatusBar = false` is for the component gallery.
 */
@Composable
fun ChatSessionHeader(
    sessionLabel: String,
    context: ContextBarView?,
    modeOptions: List<String>,
    selectedMode: String,
    onSelectMode: (String) -> Unit,
    onOpenMenu: () -> Unit,
    onOpenHistory: () -> Unit,
    showStop: Boolean,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    padStatusBar: Boolean = true,
) {
    val colors = RivetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.4f))
            .then(if (padStatusBar) Modifier.statusBarsPadding() else Modifier)
            .drawBehind {
                val y = size.height - Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .height(Dimens.pageHeader)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Android opens every session against its own node (no cross-node
        // proxying like the web's), so the remote badge slot is never filled.
        narrowHeaderItems(running = showStop, remote = false).forEach { item ->
            when (item) {
                NarrowHeaderItem.Menu -> {
                    val openMenu = stringResource(R.string.cd_open_drawer)
                    Box(
                        Modifier
                            .size(Dimens.touchTarget)
                            .semantics {
                                contentDescription = openMenu
                                role = Role.Button
                            }
                            .clickable(role = Role.Button, onClick = onOpenMenu),
                        contentAlignment = Alignment.Center,
                    ) {
                        Lucide(
                            R.drawable.lucide_menu,
                            contentDescription = null,
                            tint = colors.inkDim,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                NarrowHeaderItem.Title -> Text(
                    sessionLabel,
                    color = colors.inkDim,
                    style = RivetType.xs.copy(fontFamily = RivetFonts.Mono),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // chat.tsx:1590-1597 — the cross-node badge has no Android case.
                NarrowHeaderItem.Remote -> Unit
                NarrowHeaderItem.Context -> if (context != null) {
                    ContextBar(view = context)
                }
                NarrowHeaderItem.Stop -> HeaderStopButton(onClick = onStop)
                NarrowHeaderItem.Segmented -> SegmentedControl(
                    options = modeOptions,
                    selected = selectedMode,
                    onSelect = onSelectMode,
                )
                NarrowHeaderItem.History -> {
                    val conversations = stringResource(R.string.cd_conversations)
                    Box(
                        Modifier
                            .size(Dimens.touchTarget)
                            .semantics {
                                contentDescription = conversations
                                role = Role.Button
                            }
                            .clickable(role = Role.Button, onClick = onOpenHistory),
                        contentAlignment = Alignment.Center,
                    ) {
                        Lucide(
                            R.drawable.lucide_history,
                            contentDescription = null,
                            tint = colors.inkDim,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Web Stop (chat.tsx:1606-1615): `rounded border line px-2 py-1 mono 11px inkDim`, pressed → red. */
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
