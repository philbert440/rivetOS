package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Desktop popover stand-in: `rounded-lg border line bg panel2 p-2`.
 * Drag handle hidden; 1dp `line` along the top edge.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RivetModalSheet(
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(topStart = Radius.lg, topEnd = Radius.lg)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.panel2,
        contentColor = colors.ink,
        tonalElevation = 0.dp,
        dragHandle = null,
        shape = shape,
    ) {
        Spacer(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(colors.line),
        )
        Column(Modifier.padding(8.dp).imePadding(), content = content)
    }
}

@Composable
fun SheetTextRow(label: String, color: Color, onClick: () -> Unit) {
    Text(
        label,
        color = color,
        style = RivetType.sm,
        modifier = Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
    )
}
