package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.JumpTargets
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme

/**
 * Message jumper (UX-SPEC §1.2): four stacked 36dp round buttons — top,
 * previous message, next message, bottom. Targets come from
 * `plane/MessageJumper.kt jumpTargets`; a null previous/next is disabled.
 * [onBottom] is separate so the caller can re-pin the transcript.
 */
@Composable
fun MessageJumper(
    targets: JumpTargets,
    onJump: (Int) -> Unit,
    onBottom: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        JumpButton(R.drawable.lucide_chevrons_up, stringResource(R.string.jump_top)) { onJump(targets.top) }
        JumpButton(R.drawable.lucide_chevron_up, stringResource(R.string.jump_prev), targets.prev?.let { i -> { onJump(i) } })
        JumpButton(R.drawable.lucide_chevron_down, stringResource(R.string.jump_next), targets.next?.let { i -> { onJump(i) } })
        JumpButton(R.drawable.lucide_chevrons_down, stringResource(R.string.jump_bottom), onBottom)
    }
}

@Composable
private fun JumpButton(icon: Int, label: String, onClick: (() -> Unit)?) {
    val colors = RivetTheme.colors
    val enabled = onClick != null
    Box(
        Modifier
            .size(36.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(CircleShape)
            .border(Dimens.line, colors.emDim.copy(alpha = 0.5f), CircleShape)
            .background(colors.panel)
            .semantics {
                contentDescription = label
                role = Role.Button
                if (!enabled) disabled()
            }
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Lucide(icon, contentDescription = null, tint = if (enabled) colors.em else colors.inkDim, modifier = Modifier.size(16.dp))
    }
}
