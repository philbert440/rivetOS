package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop confirm dialog: `rounded-md border line bg panel p-4`. No AlertDialog colours. */
@Composable
fun RivetConfirmDialog(
    message: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    confirmLabel: String = "OK",
    cancelLabel: String = "Cancel",
    danger: Boolean = false,
    title: String? = null,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.md)
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .border(1.dp, colors.line, shape)
                .background(colors.panel, shape)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (title != null) {
                Text(
                    title,
                    color = colors.em,
                    style = RivetType.sm.copy(fontWeight = FontWeight.SemiBold),
                )
            }
            Text(message, color = colors.inkDim, style = RivetType.xs)
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RivetButton(
                    text = confirmLabel,
                    onClick = onConfirm,
                    variant = if (danger) RivetButtonVariant.Outline else RivetButtonVariant.Default,
                    textColor = if (danger) colors.red else null,
                )
                RivetButton(
                    text = cancelLabel,
                    onClick = onDismiss,
                    variant = RivetButtonVariant.Outline,
                )
            }
        }
    }
}
