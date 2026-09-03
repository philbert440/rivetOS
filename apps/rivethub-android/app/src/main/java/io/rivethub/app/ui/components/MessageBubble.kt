package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

enum class Bubble { User, Assistant }

@Composable
fun MessageBubble(
    kind: Bubble,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Dimens.radius8)
    val border = if (kind == Bubble.User) colors.em else colors.line
    val align = if (kind == Bubble.User) Alignment.CenterEnd else Alignment.CenterStart
    Box(modifier.fillMaxWidth()) {
        Box(
            Modifier
                .align(align)
                .fillMaxWidth(Dimens.bubbleMaxWidthFraction)
                .border(Dimens.line, border, shape)
                .background(colors.panel, shape)
                .padding(horizontal = Dimens.bubblePadH, vertical = Dimens.bubblePadV),
        ) {
            val fg = if (kind == Bubble.Assistant) colors.assistant else colors.ink
            CompositionLocalProvider(
                LocalContentColor provides fg,
                LocalTextStyle provides RivetType.body.copy(color = fg, fontSize = 14.sp),
                content = content,
            )
        }
    }
}
