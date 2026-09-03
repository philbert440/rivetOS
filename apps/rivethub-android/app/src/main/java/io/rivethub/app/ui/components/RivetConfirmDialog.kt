package io.rivethub.app.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop `confirm-dialog.tsx` as a Material3 AlertDialog on `panel`/`line`/`ink`. */
@Composable
fun RivetConfirmDialog(
    message: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    confirmLabel: String = "OK",
    cancelLabel: String = "Cancel",
    danger: Boolean = false,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius8)
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.border(Dimens.line, colors.line, shape),
        shape = shape,
        containerColor = colors.panel,
        titleContentColor = colors.ink,
        textContentColor = colors.ink,
        tonalElevation = 0.dp,
        text = {
            Text(message, color = colors.ink, style = RivetType.body)
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    confirmLabel,
                    color = if (danger) colors.red else colors.em,
                    style = RivetType.meta,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(cancelLabel, color = colors.inkDim, style = RivetType.meta)
            }
        },
    )
}
