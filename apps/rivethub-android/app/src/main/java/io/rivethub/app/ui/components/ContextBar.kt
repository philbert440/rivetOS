package io.rivethub.app.ui.components

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.rivethub.app.plane.ContextBarView
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Desktop `context-bar.tsx` at phone width: the track is `hidden sm:block` and
 * the token counts are `hidden sm:inline` (context-bar.tsx:44-56), so below the
 * `sm` breakpoint only `{pct}%` survives — mono 10sp inkDim, and it stays
 * inkDim even when hot (the red fill is part of the hidden track). The app is
 * a phone app, so it renders the phone branch.
 */
@Composable
fun ContextBar(
    view: ContextBarView,
    modifier: Modifier = Modifier,
) {
    Text(
        "${view.pct}%",
        color = RivetTheme.colors.inkDim,
        style = RivetType.mono10,
        maxLines = 1,
        modifier = modifier,
    )
}
