package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Desktop settings theme / font-size group: outline chips, selected `bg-em text-bg`. */
@Composable
fun ThemeGroup(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { option ->
            val active = option == selected
            RivetButton(
                text = option,
                onClick = { onSelect(option) },
                variant = if (active) RivetButtonVariant.Default else RivetButtonVariant.Outline,
                size = RivetButtonSize.Sm,
            )
        }
    }
}
