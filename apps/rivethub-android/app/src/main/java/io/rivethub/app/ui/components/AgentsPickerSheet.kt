package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.AgentSheetAction
import io.rivethub.app.plane.agentPickerKeys
import io.rivethub.app.plane.agentPickerMaxHeightDp
import io.rivethub.app.plane.agentPickerSubtitle
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Drawer v2 Agents picker (UX-SPEC §2 item 4 / §3), opened from the drawer
 * footer's Agents button. One row per agent via [AgentRowChrome] with a
 * node (· directory) subtitle. Tap → [onPick] (the host opens a NEW
 * conversation, `AgentAction.Plus`) and the sheet closes; long-press keeps
 * the existing agent action sheet.
 *
 * fix1: the rows are a keyed LazyColumn capped at 70% of the window height
 * (`plane/DrawerNav.kt` [agentPickerMaxHeightDp]), so the last agent of a
 * large fleet is reachable on a short screen and at large font scales. The
 * header "+" is gone — it only reopened a second picker for the same agents
 * (there is no create-agent flow).
 */
@Composable
fun AgentsPickerSheet(
    agents: List<AgentRow>,
    onDismiss: () -> Unit,
    onPick: (AgentRow) -> Unit,
    onAction: (AgentRow, AgentSheetAction) -> Unit,
) {
    val colors = RivetTheme.colors
    var actionFor by remember { mutableStateOf<AgentRow?>(null) }
    val maxHeight = agentPickerMaxHeightDp(LocalConfiguration.current.screenHeightDp).dp
    RivetModalSheet(onDismiss = onDismiss) {
        Text(
            stringResource(R.string.agents_picker_title),
            color = colors.inkDim,
            style = RivetType.mono10,
            modifier = Modifier.padding(8.dp),
        )
        if (agents.isEmpty()) {
            Text(
                stringResource(R.string.empty_agents),
                color = colors.inkDim,
                style = RivetType.xs,
                modifier = Modifier.padding(8.dp),
            )
        } else {
            val keys = agentPickerKeys(agents)
            LazyColumn(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = maxHeight),
            ) {
                itemsIndexed(agents, key = { i, _ -> keys[i] }) { _, row ->
                    AgentRowChrome(
                        row = row,
                        onTap = { onPick(row) },
                        onLong = { actionFor = row },
                        subtitle = agentPickerSubtitle(row.nodeName, null),
                    )
                }
            }
        }
    }
    actionFor?.let { row ->
        AgentActionSheet(
            name = row.name,
            online = row.online,
            onDismiss = { actionFor = null },
            onAction = { action ->
                actionFor = null
                onAction(row, action)
            },
        )
    }
}
