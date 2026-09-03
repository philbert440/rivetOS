package io.rivethub.app.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AttachmentStatus
import io.rivethub.app.plane.PendingAttachment
import io.rivethub.app.plane.pickerRowCompact
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun Composer(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    connected: Boolean,
    sending: Boolean,
    sendEnabled: Boolean,
    canStop: Boolean,
    error: String?,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    ask: @Composable () -> Unit = {},
    attachments: List<PendingAttachment> = emptyList(),
    onRemoveAttachment: (String) -> Unit = {},
    pickers: @Composable RowScope.(compact: Boolean) -> Unit = {},
) {
    val colors = RivetTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.6f))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!error.isNullOrBlank()) {
            Text("✗ $error", color = colors.red, style = RivetType.xs.copy(fontFamily = RivetFonts.Mono))
        }
        ask()
        if (attachments.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                attachments.forEach { a ->
                    AttachmentChip(a, onRemove = { onRemoveAttachment(a.id) })
                }
            }
        }
        val focusSource = remember { MutableInteractionSource() }
        val focused by focusSource.collectIsFocusedAsState()
        val shellShape = RoundedCornerShape(Radius.xl)
        val borderColor = if (focused) colors.em.copy(alpha = 0.6f) else colors.line
        Column(
            Modifier
                .fillMaxWidth()
                .alpha(if (connected) 1f else 0.7f)
                .border(Dimens.line, borderColor, shellShape)
                .then(
                    if (focused) Modifier.border(1.dp, colors.em.copy(alpha = 0.3f), shellShape)
                    else Modifier,
                )
                .background(colors.panel, shellShape)
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).padding(top = 4.dp)) {
                if (value.isEmpty()) {
                    Text(placeholder, color = colors.inkDim, style = RivetType.sm)
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled && connected && !sending,
                    textStyle = RivetType.sm.copy(color = colors.ink),
                    cursorBrush = SolidColor(colors.em),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Default,
                    ),
                    minLines = 1,
                    maxLines = 8,
                    interactionSource = focusSource,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val compact = pickerRowCompact(maxWidth.value)
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    pickers(compact)
                    Spacer(Modifier.weight(1f))
                    val attachCd = stringResource(R.string.cd_attach)
                    Box(
                        Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .semantics {
                                contentDescription = attachCd
                                role = Role.Button
                            }
                            .clickable(enabled = enabled && connected, role = Role.Button, onClick = onAttach),
                        contentAlignment = Alignment.Center,
                    ) {
                        Lucide(
                            R.drawable.lucide_paperclip,
                            contentDescription = null,
                            tint = colors.inkDim,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    val showStop = sending
                    val sendCd = stringResource(if (showStop) R.string.cd_stop else R.string.cd_send)
                    val sendOn = if (showStop) canStop else sendEnabled
                    Box(
                        Modifier.size(Dimens.touchTarget),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(32.dp)
                                .alpha(if (sendOn) 1f else 0.4f)
                                .clip(CircleShape)
                                .background(colors.panel2)
                                .semantics {
                                    contentDescription = sendCd
                                    role = Role.Button
                                }
                                .clickable(
                                    enabled = enabled && sendOn,
                                    role = Role.Button,
                                    onClick = if (showStop) onStop else onSend,
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Lucide(
                                if (showStop) R.drawable.lucide_square else R.drawable.lucide_arrow_up,
                                contentDescription = null,
                                tint = colors.em,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ComposerPicker(
    @DrawableRes icon: Int,
    label: String,
    compact: Boolean,
    options: List<SelectOption>,
    value: String,
    onChange: (String) -> Unit,
    title: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = RivetTheme.colors
    var open by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val cd = "$title: $label"
    Row(
        modifier
            .semantics {
                contentDescription = cd
                role = Role.Button
            }
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = { open = true },
            )
            .background(if (pressed) colors.panel2 else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(Radius.sm))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(16.dp))
        if (!compact) {
            Text(
                label,
                color = if (pressed) colors.ink else colors.inkDim,
                style = RivetType.sm,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Lucide(
            R.drawable.lucide_chevron_down,
            contentDescription = null,
            tint = colors.inkDim,
            modifier = Modifier.size(12.dp),
        )
    }
    RivetSelectSheet(
        visible = open,
        onDismiss = { open = false },
        options = options,
        value = value,
        onChange = {
            onChange(it)
            open = false
        },
        title = title,
    )
}

@Composable
private fun AttachmentChip(a: PendingAttachment, onRemove: () -> Unit) {
    val colors = RivetTheme.colors
    val pulse = rememberInfiniteTransition(label = "att")
    val alpha by pulse.animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "att-a",
    )
    val border = when (a.status) {
        AttachmentStatus.FAILED -> colors.red.copy(alpha = 0.6f)
        AttachmentStatus.UPLOADING -> colors.line
        AttachmentStatus.READY -> colors.emDim.copy(alpha = 0.6f)
    }
    val fg = when (a.status) {
        AttachmentStatus.FAILED -> colors.red
        AttachmentStatus.UPLOADING -> colors.inkDim
        AttachmentStatus.READY -> colors.ink
    }
    val shape = RoundedCornerShape(Radius.full)
    Row(
        Modifier
            .alpha(if (a.status == AttachmentStatus.UPLOADING) alpha else 1f)
            .border(Dimens.line, border, shape)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Lucide(R.drawable.lucide_paperclip, contentDescription = null, tint = fg, modifier = Modifier.size(12.dp))
        Text(
            a.name,
            color = fg,
            style = RivetType.mono11,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        val remove = stringResource(R.string.cd_remove_attachment, a.name)
        Box(
            Modifier
                .size(16.dp)
                .semantics {
                    contentDescription = remove
                    role = Role.Button
                }
                .clickable(role = Role.Button, onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(R.drawable.lucide_x, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(12.dp))
        }
    }
}
