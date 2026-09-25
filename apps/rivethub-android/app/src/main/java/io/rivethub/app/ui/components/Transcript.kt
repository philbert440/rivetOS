package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AttachedRef
import io.rivethub.app.plane.CotFold
import io.rivethub.app.plane.CotStep
import io.rivethub.app.plane.ReasoningSpan
import io.rivethub.app.plane.StatsLine
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

data class ToolRow(
    val title: String,
    val status: String,
)

/**
 * User turn (UX-SPEC §1.3): a right-aligned bubble in the accent-tinted
 * surface ([text] is the body with attachment lines already stripped), the
 * [attachments] as chips under it, then the [actionRow] when revealed.
 * [onTap] starts edit (only when there is a body); [onLongPress] reveals the
 * action row (it copies when the caller wires no actions).
 *
 * The long-press lives on the bubble container (body + chips), so a turn that
 * is only attachments still has a reveal path: the text bubble and image
 * thumbnails consume their own presses and forward long-press to the same
 * handler, a file pill or the gap between chips falls through to the
 * container, and TalkBack gets a "Message actions" long-click / custom action
 * on the container.
 */
@Composable
fun TranscriptUserTurn(
    text: String,
    time: String?,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier,
    attachments: List<AttachedRef> = emptyList(),
    images: AttachmentImageSource? = null,
    onTap: () -> Unit = {},
    onLongPress: (() -> Unit)? = null,
    actionRow: (@Composable () -> Unit)? = null,
) {
    val colors = RivetTheme.colors
    val longPress = onLongPress ?: { onCopy(text) }
    // The gesture detector reads the latest handler instead of restarting on
    // every recomposition (a restart would drop a long-press in progress).
    val currentLongPress by rememberUpdatedState(longPress)
    val actionsLabel = stringResource(R.string.message_actions_cd)
    val editLabel = stringResource(R.string.message_edit_cd)
    Column(
        modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AvatarRow(mine = true, time = time)
        if (text.isNotBlank() || attachments.isNotEmpty()) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                Column(
                    Modifier
                        .align(Alignment.CenterEnd)
                        .widthIn(max = maxWidth * 0.85f)
                        .pointerInput(Unit) { detectTapGestures(onLongPress = { currentLongPress() }) }
                        .then(
                            // Chips present: the container is a TalkBack stop (file pills merge
                            // into it) carrying the reveal. Text-only turns use the bubble's own.
                            if (attachments.isEmpty()) {
                                Modifier
                            } else {
                                Modifier.semantics(mergeDescendants = true) {
                                    onLongClick(label = actionsLabel) {
                                        longPress()
                                        true
                                    }
                                    customActions = listOf(
                                        CustomAccessibilityAction(actionsLabel) {
                                            longPress()
                                            true
                                        },
                                    )
                                }
                            },
                        ),
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (text.isNotBlank()) {
                        val shape = RoundedCornerShape(Radius.xxl)
                        Text(
                            text,
                            color = colors.ink,
                            style = RivetType.sm,
                            modifier = Modifier
                                .clip(shape)
                                .background(colors.em.copy(alpha = 0.12f), shape)
                                .border(Dimens.line, colors.em.copy(alpha = 0.35f), shape)
                                .combinedClickable(
                                    onClickLabel = editLabel,
                                    onClick = onTap,
                                    onLongClickLabel = actionsLabel,
                                    onLongClick = longPress,
                                )
                                .padding(horizontal = Dimens.bubblePadH, vertical = Dimens.bubblePadV),
                        )
                    }
                    if (attachments.isNotEmpty()) {
                        AttachmentChips(attachments, images, onLongPress = longPress)
                    }
                }
            }
        }
        actionRow?.invoke()
    }
}

/**
 * Assistant turn: avatar row, the chain-of-thought timeline ([steps] folded
 * to [fold]; UX-SPEC §1.3), then the markdown body, the [actionRow] (tap
 * the body to reveal it, or always per settings) and the token [stats]. [liveSpan] is the phone
 * reasoning clock and is set only for the in-flight turn; [nowMs] is the
 * clock the span was sampled with, so the live label ticks on the same base.
 */
@Composable
fun TranscriptAssistantTurn(
    text: String,
    model: String?,
    time: String?,
    accent: Color,
    steps: List<CotStep>,
    fold: CotFold,
    expanded: Boolean,
    onToggleFold: () -> Unit,
    onToolTap: (CotStep.Tool) -> Unit,
    stats: StatsLine?,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier,
    codeLineNumbers: Boolean = false,
    codeWrap: Boolean = false,
    liveSpan: ReasoningSpan? = null,
    nowMs: () -> Long = System::currentTimeMillis,
    onTap: () -> Unit = {},
    actionRow: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AvatarRow(mine = false, time = time, model = model, accent = accent)
        if (steps.isNotEmpty()) {
            CotTimeline(
                fold = fold,
                stepCount = steps.size,
                expanded = expanded,
                onToggleFold = onToggleFold,
                onToolTap = onToolTap,
                liveSpan = liveSpan,
                nowMs = nowMs,
            )
        }
        if (text.isNotBlank()) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                Box(Modifier.widthIn(max = maxWidth * 0.85f).fillMaxWidth()) {
                    // Tap reveals the action row (UX-SPEC §1.3); long-press still copies.
                    MarkdownBody(
                        text,
                        codeLineNumbers = codeLineNumbers,
                        codeWrap = codeWrap,
                        modifier = Modifier.combinedClickable(
                            onClick = onTap,
                            onLongClick = { onCopy(text) },
                        ),
                    )
                }
            }
        }
        actionRow?.invoke()
        if (stats != null) {
            StatsLineRow(stats)
        }
    }
}

@Composable
fun AvatarRow(
    mine: Boolean,
    time: String?,
    model: String? = null,
    accent: Color = RivetTheme.colors.em,
) {
    val colors = RivetTheme.colors
    if (mine) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.label_you),
                color = colors.ink.copy(alpha = 0.9f),
                style = RivetType.sm.copy(fontWeight = FontWeight.Medium),
            )
            if (time != null) {
                Text(time, color = colors.inkDim, style = RivetType.mono10)
            }
        }
    } else {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(28.dp)
                    .clip(RoundedCornerShape(Radius.md))
                    .background(colors.panel2)
                    .border(1.dp, accent, RoundedCornerShape(Radius.md))
                    .padding(2.dp),
                contentAlignment = Alignment.Center,
            ) {
                DenBot(size = 24.dp, decorative = true)
            }
            Text(
                stringResource(R.string.label_rivet),
                color = accent,
                style = RivetType.sm.copy(fontWeight = FontWeight.Medium),
            )
            if (!model.isNullOrBlank()) {
                Text(
                    model,
                    color = colors.inkDim,
                    style = RivetType.mono10,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (time != null) {
                Text(time, color = colors.inkDim, style = RivetType.mono10)
            }
        }
    }
}

@Composable
fun ThinkingFold(text: String, initiallyOpen: Boolean = false, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    var open by remember { mutableStateOf(initiallyOpen) }
    val shape = RoundedCornerShape(Radius.sm)
    Column(
        modifier
            .fillMaxWidth()
            .border(1.dp, colors.line.copy(alpha = 0.8f), shape)
            .background(colors.bg.copy(alpha = 0.4f), shape),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = { open = !open })
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (open) "▾" else "▸", color = colors.inkDim, style = RivetType.mono11)
            Text(stringResource(R.string.thinking_chip), color = colors.inkDim, style = RivetType.mono11)
        }
        if (open) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.line.copy(alpha = 0.6f)))
            ThinkingText(text)
        }
    }
}

/** The open body of [ThinkingFold]: mono 11sp `inkDim`. */
@Composable
private fun ThinkingText(text: String) {
    Text(
        text,
        color = RivetTheme.colors.inkDim,
        style = RivetType.mono11,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
    )
}

/** Full reasoning text in the [ThinkingFold] frame, for the timeline's tap-to-expand. */
@Composable
internal fun ThinkingBody(text: String, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    Box(
        modifier
            .fillMaxWidth()
            .border(1.dp, colors.line.copy(alpha = 0.8f), shape)
            .background(colors.bg.copy(alpha = 0.4f), shape),
    ) {
        ThinkingText(text)
    }
}

@Composable
fun AgentStatusLine(text: String, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    Row(
        modifier.padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // The app's loading animation (no spinners): the pulsing em dot.
        PulseDot(colors.em)
        Text(text, color = colors.inkDim, style = RivetType.mono11)
    }
}

/**
 * One tool call. In the chain-of-thought timeline the rail dot carries the
 * status ([showDot] = false), an [icon] leads the title and [onClick] opens
 * the tool detail sheet.
 */
@Composable
fun ToolStatusRow(
    tool: ToolRow,
    modifier: Modifier = Modifier,
    showDot: Boolean = true,
    icon: Int? = null,
    onClick: (() -> Unit)? = null,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    val dot = when (tool.status) {
        "running" -> colors.em
        "error" -> colors.red
        else -> colors.inkDim
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .border(Dimens.line, colors.line, shape)
            .background(colors.bg.copy(alpha = 0.6f), shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (showDot) Box(Modifier.size(6.dp).clip(CircleShape).background(dot))
        if (icon != null) Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(12.dp))
        Text(
            tool.title,
            color = colors.ink,
            style = RivetType.mono11,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        when (tool.status) {
            "done" -> Lucide(R.drawable.lucide_check, contentDescription = stringResource(R.string.tool_status_done), tint = colors.inkDim, modifier = Modifier.size(12.dp))
            "error" -> Lucide(R.drawable.lucide_x, contentDescription = stringResource(R.string.tool_status_failed), tint = colors.red, modifier = Modifier.size(12.dp))
            else -> Text(
                tool.status,
                color = colors.inkDim.copy(alpha = 0.7f),
                style = RivetType.mono10,
            )
        }
    }
}

@Composable
fun StatsLineRow(stats: StatsLine, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    val dim = colors.inkDim.copy(alpha = 0.7f)
    Row(
        modifier.padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatBit(R.drawable.lucide_arrow_up, stats.promptLabel, dim)
        StatBit(R.drawable.lucide_arrow_down, stats.completionLabel, dim)
    }
}

@Composable
private fun StatBit(icon: Int, label: String, tint: androidx.compose.ui.graphics.Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Lucide(icon, contentDescription = null, tint = tint, modifier = Modifier.size(12.dp))
        Text(label, color = tint, style = RivetType.mono10)
    }
}

@Composable
fun CopyGlyph(
    onCopy: () -> Unit,
    modifier: Modifier = Modifier,
    copied: Boolean = false,
    contentDescription: String = stringResource(R.string.cd_copy_message),
) {
    val colors = RivetTheme.colors
    val scope = rememberCoroutineScope()
    var flash by remember { mutableStateOf(copied) }
    val shape = RoundedCornerShape(Radius.sm)
    val cd = if (flash) stringResource(R.string.cd_copied) else contentDescription
    Box(
        modifier
            .size(Dimens.touchTarget)
            .clip(shape)
            .semantics {
                this.contentDescription = cd
                role = Role.Button
            }
            .clickable(role = Role.Button, onClick = {
                onCopy()
                flash = true
                scope.launch {
                    delay(1500)
                    flash = false
                }
            }),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .border(Dimens.line, colors.line, shape)
                .background(colors.panel.copy(alpha = 0.9f), shape)
                .padding(4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(
                if (flash) R.drawable.lucide_check else R.drawable.lucide_copy,
                contentDescription = null,
                tint = if (flash) colors.em else colors.inkDim,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}
