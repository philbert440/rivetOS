package io.rivethub.app.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import io.rivethub.app.ui.theme.RivetTheme

/** Lucide vector from `res/drawable/lucide_*` — tint at the call site, never Material Icons. */
@Composable
fun Lucide(
    @DrawableRes id: Int,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = RivetTheme.colors.ink,
) {
    Icon(
        painter = painterResource(id),
        contentDescription = contentDescription,
        modifier = modifier,
        tint = tint,
    )
}
