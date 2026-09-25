package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.DrawerFooterAction
import io.rivethub.app.plane.ExperimentalFlags
import io.rivethub.app.plane.drawerFooterActions
import io.rivethub.app.ui.theme.RivetTheme

/**
 * Drawer v2 footer (UX-SPEC §2 item 4): a row of 44dp round `panel` buttons
 * with a 1dp `line` ring — Agents · Tasks (flagged) · Memory · Settings. The
 * set and order come from `plane/DrawerNav.kt drawerFooterActions`.
 */
@Composable
fun DrawerFooter(
    exp: ExperimentalFlags,
    onAction: (DrawerFooterAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            // fix1: four buttons + gaps can exceed a narrow (238dp) sheet
            // once Tasks is flagged on; scroll instead of clipping.
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        drawerFooterActions(exp).forEach { action ->
            FooterButton(action) { onAction(action) }
        }
    }
}

@Composable
private fun FooterButton(action: DrawerFooterAction, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(colors.panel)
            .border(1.dp, colors.line, CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Lucide(
            action.icon(),
            contentDescription = action.label(),
            tint = colors.inkDim,
            modifier = Modifier.size(18.dp),
        )
    }
}

private fun DrawerFooterAction.icon(): Int = when (this) {
    DrawerFooterAction.Agents -> R.drawable.lucide_bot
    DrawerFooterAction.Tasks -> R.drawable.lucide_list_checks
    DrawerFooterAction.Memory -> R.drawable.lucide_library
    DrawerFooterAction.Settings -> R.drawable.lucide_settings
}

@Composable
private fun DrawerFooterAction.label(): String = stringResource(
    when (this) {
        DrawerFooterAction.Agents -> R.string.footer_agents
        DrawerFooterAction.Tasks -> R.string.footer_tasks
        DrawerFooterAction.Memory -> R.string.footer_memory
        DrawerFooterAction.Settings -> R.string.footer_settings
    },
)
