package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.StatsLine
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class OutboundChip { None, Queued, Sending }

data class ToolRow(
    val title: String,
    val status: String,
)

@Composable
fun TranscriptUserTurn(
    text: String,
    time: String?,
    outbound: OutboundChip = OutboundChip.None,
    onCopy: (String) -> Unit,
    onInject: (() -> Unit)? = null,
    onCancel: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Column(
        modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AvatarRow(mine = true, time = time)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            Box(Modifier.align(Alignment.CenterEnd).widthIn(max = maxWidth * 0.85f)) {
                val queued = outbound != OutboundChip.None
                val shape = RoundedCornerShape(Radius.lg)
                Column {
                    Text(
                        text,
                        color = if (queued) colors.inkDim else colors.ink,
                        style = RivetType.sm,
                        modifier = Modifier
                            .border(
                                Dimens.line,
                                if (queued) colors.line else colors.emDim.copy(alpha = 0.4f),
                                shape,
                            )
                            .background(
                                if (queued) colors.panel2.copy(alpha = 0.5f) else colors.emDim.copy(alpha = 0.1f),
                                shape,
                            )
                            .combinedClickable(
                                onClick = {},
                                onLongClick = { onCopy(text) },
                            )
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                    CopyGlyph(
                        copied = false,
                        onCopy = { onCopy(text) },
                        modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    )
                }
            }
        }
        if (outbound != OutboundChip.None) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (outbound == OutboundChip.Queued) {
                        stringResource(R.string.status_queued)
                    } else {
                        stringResource(R.string.status_sending)
                    },
                    color = colors.inkDim,
                    style = RivetType.mono10,
                )
                if (outbound == OutboundChip.Queued && onInject != null) {
                    Text(
                        stringResource(R.string.action_inject),
                        color = colors.em,
                        style = RivetType.mono10,
                        modifier = Modifier.clickable(role = Role.Button, onClick = onInject),
                    )
                }
                if (onCancel != null) {
                    Text(
                        stringResource(R.string.action_cancel_queue),
                        color = colors.red,
                        style = RivetType.mono10,
                        modifier = Modifier.clickable(role = Role.Button, onClick = onCancel),
                    )
                }
            }
        }
    }
}

@Composable
fun TranscriptAssistantTurn(
    text: String,
    thinking: String?,
    model: String?,
    time: String?,
    accent: Color,
    tools: List<ToolRow>,
    stats: StatsLine?,
    onCopy: (String) -> Unit,
    thinkingOpenDefault: Boolean = false,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AvatarRow(mine = false, time = time, model = model, accent = accent)
        if (!thinking.isNullOrBlank()) {
            ThinkingFold(text = thinking, initiallyOpen = thinkingOpenDefault)
        }
        if (tools.isNotEmpty()) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                tools.forEach { tool -> ToolStatusRow(tool) }
            }
        }
        if (text.isNotBlank()) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                Box(Modifier.widthIn(max = maxWidth * 0.85f)) {
                    MarkdownBody(
                        text,
                        modifier = Modifier.combinedClickable(
                            onClick = {},
                            onLongClick = { onCopy(text) },
                        ),
                    )
                    CopyGlyph(
                        copied = false,
                        onCopy = { onCopy(text) },
                        modifier = Modifier.align(Alignment.TopEnd),
                    )
                }
            }
        }
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
            Text(
                text,
                color = colors.inkDim,
                style = RivetType.mono11,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
fun ToolStatusRow(tool: ToolRow, modifier: Modifier = Modifier) {
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
            .border(Dimens.line, colors.line, shape)
            .background(colors.bg.copy(alpha = 0.6f), shape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(dot))
        Text(
            tool.title,
            color = colors.ink,
            style = RivetType.mono11,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            tool.status,
            color = colors.inkDim.copy(alpha = 0.7f),
            style = RivetType.mono10,
        )
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
        stats.tpsLabel?.let { StatBit(R.drawable.lucide_zap, it, dim) }
        stats.durationLabel?.let { StatBit(R.drawable.lucide_clock_3, it, dim) }
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
) {
    val colors = RivetTheme.colors
    val scope = rememberCoroutineScope()
    var flash by remember { mutableStateOf(copied) }
    val shape = RoundedCornerShape(Radius.sm)
    Box(
        modifier
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel.copy(alpha = 0.9f), shape)
            .clickable(role = Role.Button, onClick = {
                onCopy()
                flash = true
                scope.launch {
                    delay(1500)
                    flash = false
                }
            })
            .padding(4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Lucide(
            if (flash) R.drawable.lucide_check else R.drawable.lucide_copy,
            contentDescription = stringResource(
                if (flash) R.string.cd_copied else R.string.cd_copy_message,
            ),
            tint = if (flash) colors.em else colors.inkDim,
            modifier = Modifier.size(12.dp),
        )
    }
}
