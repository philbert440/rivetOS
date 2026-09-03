package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import androidx.compose.ui.unit.sp

@Composable
fun KeyToolbar(
    keys: List<String>,
    onKey: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius6)
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.panel2)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Dimens.grid, vertical = Dimens.gridHalf),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        keys.forEach { key ->
            Box(
                Modifier
                    .height(Dimens.keyHeight)
                    .clip(shape)
                    .background(colors.panel, shape)
                    .border(Dimens.line, colors.line, shape)
                    .clickable(role = Role.Button, onClick = { onKey(key) })
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(key, color = colors.ink, fontFamily = RivetFonts.Mono, fontSize = 12.sp)
            }
        }
    }
}
