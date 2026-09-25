package io.rivethub.app.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import io.rivethub.app.R
import io.rivethub.app.plane.ContextBarView
import io.rivethub.app.plane.NarrowHeaderItem
import io.rivethub.app.plane.headerItemsV2
import io.rivethub.app.plane.SessionMode
import io.rivethub.app.plane.TitleBlock
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Session row derived from the web chat.tsx narrow header and docs/UX-SPEC.md U1.
 * Chat: menu, readable two-line title (tap rename, long-press history until U2b),
 * optional Stop, Terminal chip, search, new chat. Search hides the chip and new chat.
 * Terminal retains the session id, context pill, mode segment and history until U6.
 * The row owns the status inset. Its full-width context track doubles as the bottom
 * border even without usage data: 1dp in Chat, the existing 2dp in Terminal.
 */
@OptIn(ExperimentalFoundationApi::class)
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
    mode: SessionMode = SessionMode.Terminal,
    titleBlock: TitleBlock = TitleBlock(sessionLabel, ""),
    searchActive: Boolean = false,
    onRenameTap: () -> Unit = {},
    onMode: (SessionMode) -> Unit = {},
    onSearch: () -> Unit = {},
    onNewChat: () -> Unit = {},
) {
    val colors = RivetTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .background(if (mode == SessionMode.Chat) colors.bg else colors.panel.copy(alpha = 0.4f)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (padStatusBar) Modifier.statusBarsPadding() else Modifier)
                .height(Dimens.pageHeader)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (mode == SessionMode.Chat) 2.dp else 8.dp),
        ) {
            // Android opens every session against its own node (no cross-node
            // proxying like the web's), so the remote badge slot is never filled.
            headerItemsV2(running = showStop, remote = false, searchActive = searchActive, mode = mode).forEach { item ->
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
                    NarrowHeaderItem.TitleBlock -> {
                        Column(
                            Modifier.weight(1f).height(Dimens.touchTarget)
                                .clip(RoundedCornerShape(Radius.sm))
                                .combinedClickable(
                                    role = Role.Button,
                                    onClickLabel = stringResource(R.string.action_rename),
                                    onLongClickLabel = stringResource(R.string.action_history),
                                    onClick = onRenameTap,
                                    onLongClick = onOpenHistory,
                                ),
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(
                                titleBlock.line1,
                                color = colors.ink,
                                style = RivetType.sm.copy(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                titleBlock.line2,
                                color = colors.inkDim,
                                style = RivetType.mono11,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    NarrowHeaderItem.TerminalChip -> {
                        val label = stringResource(R.string.terminal_chip)
                        Box(
                            Modifier.height(Dimens.touchTarget)
                                .semantics { contentDescription = label }
                                .clickable(role = Role.Button) { onMode(SessionMode.Terminal) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(
                                Modifier.border(1.dp, colors.line, RoundedCornerShape(Radius.full))
                                    .padding(horizontal = 8.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Lucide(R.drawable.lucide_code, null, tint = colors.inkDim, modifier = Modifier.size(14.dp))
                                Text(label, color = colors.inkDim, style = RivetType.mono11, maxLines = 1)
                            }
                        }
                    }
                    NarrowHeaderItem.Search -> HeaderIconButton(
                        icon = if (searchActive) R.drawable.lucide_x else R.drawable.lucide_search,
                        description = stringResource(if (searchActive) R.string.close_search else R.string.search_messages),
                        onClick = onSearch,
                    )
                    NarrowHeaderItem.NewChat -> HeaderIconButton(
                        icon = R.drawable.lucide_plus,
                        description = stringResource(R.string.new_chat),
                        onClick = onNewChat,
                    )
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
        ContextCompactionTrack(view = context, height = if (mode == SessionMode.Chat) 1.dp else 2.dp)
    }
}

/**
 * Full-width context-compaction track: Chat uses 1dp; Terminal keeps 2dp,
 * filled to [ContextBarView.fraction] where 100% = forced compaction. Fill is
 * `em` → `warn` (≥70%) → `red` (≥90%); the unfilled `line` segment reads as
 * the header's bottom border, so the track is drawn even with no data. Plain
 * `Box` + `drawBehind` over Rivet tokens — no Material progress chrome.
 * `animateFloatAsState` lets a post-compaction drop sweep down.
 */
@Composable
private fun ContextCompactionTrack(view: ContextBarView?, height: androidx.compose.ui.unit.Dp) {
    val colors = RivetTheme.colors
    val fraction by animateFloatAsState(
        targetValue = view?.fraction ?: 0f,
        label = "contextCompactionFill",
    )
    val fill = when {
        view == null -> colors.line
        view.hot -> colors.red
        view.warn -> colors.warn
        else -> colors.em
    }
    val description = view?.let { stringResource(R.string.cd_context_fill, it.pct) }
    Box(
        Modifier
            .fillMaxWidth()
            .height(height)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
            .drawBehind {
                drawRect(colors.line)
                if (fraction > 0f) {
                    drawRect(fill, topLeft = Offset.Zero, size = Size(size.width * fraction, size.height))
                }
            },
    )
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

@Composable
private fun HeaderIconButton(icon: Int, description: String, onClick: () -> Unit) {
    Box(
        Modifier.size(Dimens.touchTarget)
            .clip(RoundedCornerShape(Radius.sm))
            .semantics { contentDescription = description }
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Lucide(icon, null, tint = RivetTheme.colors.inkDim, modifier = Modifier.size(20.dp))
    }
}
