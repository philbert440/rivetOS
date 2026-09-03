package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

enum class PillTone { Dim, Em, Warn }

@Composable
fun Pill(
    text: String,
    tone: PillTone = PillTone.Dim,
    mono: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val fg = when (tone) {
        PillTone.Dim -> colors.inkDim
        PillTone.Em -> colors.em
        PillTone.Warn -> colors.warn
    }
    val shape = RoundedCornerShape(Dimens.radiusPill)
    Box(
        modifier
            .height(Dimens.pillHeight)
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel2, shape)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = fg,
            style = if (mono) RivetType.monoPill else RivetType.meta.copy(fontSize = RivetType.monoPill.fontSize),
            fontFamily = if (mono) RivetFonts.Mono else FontFamily.Default,
            maxLines = 1,
        )
    }
}
