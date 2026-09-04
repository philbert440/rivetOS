package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.components.DenBot
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * The launch surface while the initial session resolves (Phil 2026-09-04: the
 * home is a session, never the conversations list — web `ChatLaunchLoading`,
 * chat.tsx): the wordmark TopBar (it renders on every narrow non-session
 * screen) over the centered DenBot + "Loading most recent conversation…"
 * copy, with a New-conversation button that opens a fresh draft INSTANTLY —
 * bypassing the most-recent resolve so the user never has to wait. Never the
 * list, never a blank, no spinner (D2-8). Shown by HubScreen on the
 * Conversations tab until MainActivity's launch resolution opens the session
 * (instant resume / pick / new draft).
 */
@Composable
fun ChatLaunchScreen(onOpenDrawer: () -> Unit, onNew: () -> Unit) {
    val colors = RivetTheme.colors
    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(
            title = stringResource(R.string.brand_rivethub),
            onOpenDrawer = onOpenDrawer,
        )
        // Web (chat.tsx ChatLaunchLoading): centered, DenBot size-16 (64dp)
        // opacity-90, text-sm inkDim copy, and a raw bordered button
        // (`rounded border border-line px-3 py-1.5 text-xs text-ink-dim`,
        // hover → border-em/text-em mapped to pressed) with a 44dp hit box.
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            DenBot(size = 64.dp, decorative = true, modifier = Modifier.alpha(0.9f))
            Text(
                stringResource(R.string.loading_recent_conversation),
                color = colors.inkDim,
                style = RivetType.sm,
            )
            NewDraftButton(onClick = onNew)
        }
    }
}

@Composable
private fun NewDraftButton(onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(Radius.sm)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .sizeIn(minWidth = Dimens.touchTarget, minHeight = Dimens.touchTarget)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            ),
    ) {
        Text(
            stringResource(R.string.agent_new_conversation),
            color = if (pressed) colors.em else colors.inkDim,
            style = RivetType.xs,
            maxLines = 1,
            modifier = Modifier
                .clip(shape)
                .border(1.dp, if (pressed) colors.em else colors.line, shape)
                .padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}
