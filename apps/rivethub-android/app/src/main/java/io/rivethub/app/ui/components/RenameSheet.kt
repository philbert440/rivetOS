package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun RenameSheet(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember(initial) { mutableStateOf(initial) }
    RivetModalSheet(onDismiss = onDismiss) {
        Column(Modifier.imePadding()) {
            Text(
                stringResource(R.string.rename_title),
                color = RivetTheme.colors.em,
                style = RivetType.sm,
                modifier = Modifier.padding(8.dp),
            )
            RivetField(
                value = text,
                onValueChange = { text = it },
                placeholder = stringResource(R.string.rename_hint),
                size = RivetFieldSize.Rename,
            )
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RivetButton(text = stringResource(R.string.action_save), onClick = { onSave(text) })
                RivetButton(
                    text = stringResource(R.string.action_cancel),
                    onClick = onDismiss,
                    variant = RivetButtonVariant.Outline,
                )
            }
        }
    }
}
