package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.harnessAccentToken
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.ListRow
import io.rivethub.app.ui.components.Pill
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun AgentsScreen(
    vm: HubViewModel,
    onOpen: (AgentRow, AgentAction) -> Unit,
) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(title = stringResource(R.string.title_agents))
        if (st.agents.isEmpty()) {
            Text(
                stringResource(R.string.empty_agents),
                color = colors.inkDim,
                style = RivetType.meta,
                modifier = Modifier.padding(Dimens.grid2),
            )
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(st.agents, key = { "${it.agentId}:${it.nodeId}" }) { row ->
                    val accent = harnessAccentToken(row.harnessId, row.agentId).color(colors)
                    ListRow(
                        title = row.name,
                        onClick = { onOpen(row, AgentAction.Tap) },
                        accent = accent,
                        pinned = row.pointerSessionId != null,
                        meta = {
                            row.harnessId?.let {
                                Pill(it)
                                Spacer(Modifier.width(6.dp))
                            }
                            Pill(row.nodeName)
                        },
                        trailing = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconSlot(stringResource(R.string.action_replace_pin), onClick = { onOpen(row, AgentAction.Replace) }) {
                                    Icon(Icons.Outlined.Refresh, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(18.dp))
                                }
                                IconSlot(stringResource(R.string.action_new_draft), onClick = { onOpen(row, AgentAction.Plus) }) {
                                    Icon(Icons.Outlined.Add, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(18.dp))
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun IconSlot(desc: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier
            .size(Dimens.touchTarget)
            .semantics { contentDescription = desc }
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
