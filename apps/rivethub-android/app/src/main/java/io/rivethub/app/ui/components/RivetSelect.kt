package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

data class SelectOption(val value: String, val label: String)

/** Desktop `select.tsx` as a bottom sheet (phone popover stand-in). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RivetSelect(
    value: String,
    options: List<SelectOption>,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    title: String? = null,
    enabled: Boolean = true,
) {
    val colors = RivetTheme.colors
    var open by remember { mutableStateOf(false) }
    val current = options.find { it.value == value }
    val triggerLabel = current?.label ?: title ?: "Select…"
    val shape = RoundedCornerShape(Dimens.radius6)
    Row(
        modifier
            .heightIn(min = 32.dp)
            .border(Dimens.line, colors.line, shape)
            .background(colors.bg, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = { open = true })
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            triggerLabel,
            color = if (enabled) colors.ink else colors.inkDim,
            style = RivetType.monoPill,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(
            Icons.Outlined.KeyboardArrowDown,
            contentDescription = null,
            tint = colors.inkDim,
            modifier = Modifier.size(14.dp),
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

/** Bottom sheet used by [RivetSelect] and by callers that open it without a trigger. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RivetSelectSheet(
    visible: Boolean,
    onDismiss: () -> Unit,
    options: List<SelectOption>,
    value: String,
    onChange: (String) -> Unit,
    title: String? = null,
) {
    if (!visible) return
    val colors = RivetTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.panel,
        contentColor = colors.ink,
        tonalElevation = 0.dp,
    ) {
        val heading = title
        if (heading != null) {
            Text(
                heading,
                color = colors.inkDim,
                style = RivetType.monoPill,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        options.forEach { option ->
            val active = option.value == value
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = Dimens.touchTarget)
                    .clickable(role = Role.Button, onClick = { onChange(option.value) })
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    option.label,
                    color = if (active) colors.ink else colors.inkDim,
                    style = RivetType.monoPill,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (active) {
                    Icon(
                        Icons.Outlined.Check,
                        contentDescription = "Selected",
                        tint = colors.em,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}
