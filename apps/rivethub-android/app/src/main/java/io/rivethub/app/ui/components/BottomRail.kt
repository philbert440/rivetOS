package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme

data class RailItem(
    val id: String,
    val label: String,
    val icon: ImageVector,
    val enabled: Boolean = true,
)

@Composable
fun BottomRail(
    items: List<RailItem>,
    active: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Column(modifier.fillMaxWidth().background(colors.panel)) {
        HorizontalDivider(thickness = Dimens.line, color = colors.line)
        Row(
            Modifier
                .fillMaxWidth()
                .height(Dimens.railHeight),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item ->
                val selected = item.id == active
                val tint = when {
                    !item.enabled -> colors.inkDim
                    selected -> colors.em
                    else -> colors.inkDim
                }
                Column(
                    Modifier
                        .weight(1f)
                        .height(Dimens.railHeight)
                        .alpha(if (item.enabled) 1f else 0.4f)
                        .clickable(enabled = item.enabled, role = Role.Tab, onClick = { onSelect(item.id) }),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(item.icon, contentDescription = item.label, tint = tint, modifier = Modifier.size(Dimens.railIcon))
                    Text(
                        item.label,
                        color = tint,
                        fontSize = Dimens.railLabel.sp,
                        fontFamily = RivetFonts.Mono,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
