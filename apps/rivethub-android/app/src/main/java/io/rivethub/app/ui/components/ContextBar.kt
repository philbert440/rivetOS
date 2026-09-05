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
 * `sm` breakpoint only `{pct}%` survives — mono 10sp inkDim. The app is a phone
 * app, so it renders the phone branch. Phil 2026-09-04: the pill is the label
 * for the header's hairline compaction track, so its colour shifts with the
 * same thresholds — inkDim → `warn` (≥70%) → `red` (≥90%).
 */
@Composable
fun ContextBar(
    view: ContextBarView,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    Text(
        "${view.pct}%",
        color = when {
            view.hot -> colors.red
            view.warn -> colors.warn
            else -> colors.inkDim
        },
        style = RivetType.mono10,
        maxLines = 1,
        modifier = modifier,
    )
}
