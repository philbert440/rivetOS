package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Desktop `segmented-control.tsx`: 1-dp `line` border, 4-dp radius, 2-dp padding/gap, 11-sp mono, active bg `panel2`. */
@Composable
fun SegmentedControl(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius4)
    Row(
        modifier
            .clip(shape)
            .border(Dimens.line, colors.line, shape)
            .padding(2.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { option ->
            val active = option == selected
            Text(
                option,
                color = if (active) colors.em else colors.inkDim,
                style = RivetType.monoPill,
                modifier = Modifier
                    .clip(RoundedCornerShape(Dimens.radius4))
                    .background(if (active) colors.panel2 else Color.Transparent)
                    .selectable(selected = active, role = Role.RadioButton, onClick = { onSelect(option) })
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
    }
}
