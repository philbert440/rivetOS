package io.rivethub.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import io.rivethub.app.R

/** Pixel-art den bot (`image-rendering: pixelated` → [FilterQuality.None]). */
@Composable
fun DenBot(
    size: Dp,
    modifier: Modifier = Modifier,
    decorative: Boolean = false,
) {
    val desc = if (decorative) null else stringResource(R.string.cd_den_bot)
    Image(
        bitmap = ImageBitmap.imageResource(R.drawable.den_bot),
        contentDescription = desc,
        modifier = modifier.size(size),
        contentScale = ContentScale.Fit,
        filterQuality = FilterQuality.None,
    )
}
