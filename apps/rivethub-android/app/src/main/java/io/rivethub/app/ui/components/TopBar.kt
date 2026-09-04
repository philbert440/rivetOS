package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Mobile top bar — web `MobileTopBar` (sidebar.tsx:126-140):
 * `h-12 border-b border-line bg-panel/80 px-3`, ☰ (lucide `menu` `size-5` in a
 * 44dp hit box, contentDescription "Open menu") as the drawer opener, DenBot
 * `size-7` DECORATIVE beside it (web made the DenBot non-interactive in the
 * bar — sidebar.tsx:139), then the page title `font-mono text-sm text-em`
 * (`hubPageTitle`: wordmark on home, page title elsewhere). The bar is NOT
 * shown while a session is open (lib/session-header.ts) — the one-row
 * `ChatSessionHeader` owns the top inset there.
 *
 * The bar OWNS the status-bar inset: the `panel/80` background extends under
 * the status bar (`statusBarsPadding` inside the bar, never around the
 * content), so no black band shows above it. Pass `onOpenDrawer = null` on
 * screens without a drawer (enroll): no ☰, the DenBot stays decorative.
 * `padStatusBar = false` is for the component gallery, where samples render
 * mid-scroll and must show the true 48dp bar.
 */
@Composable
fun TopBar(
    title: String,
    onOpenDrawer: (() -> Unit)?,
    modifier: Modifier = Modifier,
    padStatusBar: Boolean = true,
) {
    val colors = RivetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.8f))
            .then(if (padStatusBar) Modifier.statusBarsPadding() else Modifier)
            .drawBehind {
                val y = size.height - Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .height(Dimens.pageHeader)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (onOpenDrawer != null) {
            val openMenu = stringResource(R.string.cd_open_drawer)
            Box(
                Modifier
                    .size(Dimens.touchTarget)
                    .semantics {
                        contentDescription = openMenu
                        role = Role.Button
                    }
                    .clickable(role = Role.Button, onClick = onOpenDrawer),
                contentAlignment = Alignment.Center,
            ) {
                Lucide(
                    R.drawable.lucide_menu,
                    contentDescription = null,
                    tint = colors.inkDim,
                    modifier = Modifier.size(20.dp),
                )
            }
            DenBot(size = Dimens.denBotHeader, decorative = true)
        } else {
            Box(
                Modifier.size(Dimens.touchTarget),
                contentAlignment = Alignment.Center,
            ) {
                DenBot(size = Dimens.denBotHeader, decorative = true)
            }
        }
        Text(
            title,
            color = colors.em,
            style = RivetType.mono14,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
