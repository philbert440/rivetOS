package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** Conversations-list filter chips (artboard 1). */
@Composable
fun FilterChipRow(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val idx = options.indexOf(selected).coerceAtLeast(0)
    FilterChipRow(options, idx, { i -> onSelect(options[i]) }, modifier)
}

@Composable
fun FilterChipRow(
    options: List<String>,
    selectedIndex: Int,
    onSelectIndex: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radiusPill)
    Row(
        modifier
            .selectableGroup()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEachIndexed { i, option ->
            val active = i == selectedIndex
            Text(
                option,
                color = if (active) colors.em else colors.inkDim,
                style = RivetType.monoPill,
                maxLines = 1,
                modifier = Modifier
                    .border(Dimens.line, if (active) colors.em else colors.line, shape)
                    .background(if (active) colors.panel2 else colors.bg, shape)
                    .selectable(selected = active, role = Role.RadioButton, onClick = { onSelectIndex(i) })
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}
