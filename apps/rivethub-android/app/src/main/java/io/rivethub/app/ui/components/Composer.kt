package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun Composer(
    placeholder: String,
    live: Boolean,
    pickers: @Composable RowScope.() -> Unit,
    chips: @Composable RowScope.() -> Unit,
    onAttach: () -> Unit,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    var draft by remember { mutableStateOf("") }
    fun send() {
        val t = draft.trim()
        if (t.isEmpty()) return
        onSend(t)
        draft = ""
    }
    Column(modifier.fillMaxWidth().background(colors.panel)) {
        HorizontalDivider(thickness = Dimens.line, color = colors.line)
        Column(
            Modifier.padding(
                start = Dimens.composerPadH,
                top = Dimens.composerPadTop,
                end = Dimens.composerPadH,
                bottom = Dimens.composerPadBottom,
            ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = chips,
            )
            val inputShape = RoundedCornerShape(Dimens.radius6)
            Box(
                Modifier
                    .fillMaxWidth()
                    .border(Dimens.line, colors.line, inputShape)
                    .background(colors.bg, inputShape)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                if (draft.isEmpty()) {
                    Text(placeholder, color = colors.inkDim, style = RivetType.body)
                }
                BasicTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    textStyle = RivetType.body.copy(color = colors.ink),
                    cursorBrush = SolidColor(colors.em),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    content = pickers,
                )
                IconSlot(onClick = onAttach, desc = "Attach") {
                    Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(22.dp))
                }
                if (live) {
                    IconSlot(onClick = onStop, desc = "Stop") {
                        Icon(Icons.Outlined.Stop, contentDescription = null, tint = colors.red, modifier = Modifier.size(22.dp))
                    }
                } else {
                    IconSlot(onClick = { send() }, desc = "Send") {
                        Icon(Icons.Outlined.ArrowUpward, contentDescription = null, tint = colors.em, modifier = Modifier.size(22.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun IconSlot(onClick: () -> Unit, desc: String, content: @Composable () -> Unit) {
    Box(
        Modifier
            .size(Dimens.touchTarget)
            .semantics { contentDescription = desc }
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
        content = { content() },
    )
}
