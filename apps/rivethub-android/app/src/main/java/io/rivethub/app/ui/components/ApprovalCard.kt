package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.PendingApproval
import io.rivethub.app.plane.humanToolTitle
import io.rivethub.app.plane.toolArgStrings
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Permission prompt. Desktop `harness-approval-card.tsx` at 412 px:
 * tool title, scraped reason, Allow / Allow for session / Deny.
 */
@Composable
fun ApprovalCard(
    approval: PendingApproval,
    onDecide: (requestId: String, decision: String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.xl)
    val title = humanToolTitle(approval.name, toolArgStrings(approval.input))
    Column(
        modifier
            .fillMaxWidth()
            .border(Dimens.line, colors.emDim.copy(alpha = 0.5f), shape)
            .background(colors.panel, shape)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Lucide(
                R.drawable.lucide_lock,
                contentDescription = null,
                tint = colors.em,
                modifier = Modifier.size(14.dp),
            )
            Text(
                title,
                color = colors.ink,
                style = RivetType.xs,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (!approval.reason.isNullOrBlank()) {
            Text(approval.reason, color = colors.inkDim, style = RivetType.mono11)
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RivetButton(
                text = stringResource(R.string.approval_allow),
                onClick = { onDecide(approval.requestId, "allow") },
                variant = RivetButtonVariant.Outline,
                size = RivetButtonSize.Sm,
                enabled = enabled,
                textColor = colors.em,
            )
            RivetButton(
                text = stringResource(R.string.approval_allow_session),
                onClick = { onDecide(approval.requestId, "allow-session") },
                variant = RivetButtonVariant.Ghost,
                size = RivetButtonSize.Sm,
                enabled = enabled,
            )
            RivetButton(
                text = stringResource(R.string.approval_deny),
                onClick = { onDecide(approval.requestId, "deny") },
                variant = RivetButtonVariant.Ghost,
                size = RivetButtonSize.Sm,
                enabled = enabled,
            )
        }
    }
}
