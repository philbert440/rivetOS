package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme

/**
 * RivetHub brand, set in type (web `components/brand.tsx`). The drawer header
 * shows the `rivethub` [Wordmark]; the top bar, enroll and launch surfaces
 * show its `r` and `h` as the [RhMark] monogram. Both take their colors from
 * the active theme — accent `em`, dim `inkDim` — so an Omarchy palette
 * restyles them. JetBrains Mono ExtraBold, `tracking-tight`.
 */
private fun brandStyle(size: TextUnit) = TextStyle(
    fontFamily = RivetFonts.Mono,
    fontWeight = FontWeight.ExtraBold,
    fontSize = size,
    lineHeight = size,
    letterSpacing = (-0.025).em,
)

@Composable
fun Wordmark(modifier: Modifier = Modifier, size: TextUnit = 18.sp) {
    val colors = RivetTheme.colors
    val label = stringResource(R.string.brand_rivethub)
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = colors.em)) { append("rivet") }
            withStyle(SpanStyle(color = colors.inkDim)) { append("hub") }
        },
        style = brandStyle(size),
        maxLines = 1,
        modifier = modifier.clearAndSetSemantics { contentDescription = label },
    )
}

/**
 * The R-H monogram: the wordmark's own `r` and `h`, same face, weight and
 * colors, so it reads as `rivethub` folded down. Decorative unless
 * [decorative] is false (then it reads "RivetHub").
 */
@Composable
fun RhMark(
    modifier: Modifier = Modifier,
    size: TextUnit = Dimens.brandHeaderSp.sp,
    decorative: Boolean = true,
) {
    val colors = RivetTheme.colors
    val label = stringResource(R.string.brand_rivethub)
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = colors.em)) { append("r") }
            withStyle(SpanStyle(color = colors.inkDim)) { append("h") }
        },
        style = brandStyle(size),
        maxLines = 1,
        modifier = modifier.then(
            if (decorative) Modifier.clearAndSetSemantics { } else Modifier.semantics { contentDescription = label },
        ),
    )
}

/** [RhMark] centred in a 44dp touch-target box, for bars that align icons on that grid. */
@Composable
fun RhMarkBox(modifier: Modifier = Modifier) {
    Box(modifier.size(Dimens.touchTarget), contentAlignment = Alignment.Center) { RhMark() }
}
