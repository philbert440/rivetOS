package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop settings theme / font-size group: outline chips, selected `bg-em text-bg`. */
@Composable
fun ThemeGroup(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { option ->
            val active = option == selected
            Text(
                option,
                color = if (active) colors.bg else colors.ink,
                style = RivetType.sm,
                modifier = Modifier
                    .sizeIn(minHeight = 44.dp)
                    .clip(shape)
                    .background(if (active) colors.em else colors.panel2, shape)
                    .then(
                        if (active) Modifier else Modifier.border(1.dp, colors.line, shape),
                    )
                    .clickable(role = Role.Button, onClick = { onSelect(option) })
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
    }
}
