package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.ListRow
import io.rivethub.app.ui.components.Pill
import io.rivethub.app.ui.components.SectionHeader
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun NodesScreen(vm: HubViewModel) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(title = stringResource(R.string.title_nodes))
        HubErrorLine(st.error, st.errorKind, onRetry = vm::refresh)
        Text(
            stringResource(R.string.node_filter_hint),
            color = colors.inkDim,
            style = RivetType.meta,
            modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
        )
        if (st.nodes.isEmpty()) {
            Text(
                stringResource(R.string.empty_nodes),
                color = colors.inkDim,
                style = RivetType.meta,
                modifier = Modifier.padding(Dimens.grid2),
            )
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                item {
                    SectionHeader(
                        stringResource(R.string.section_connection),
                        modifier = Modifier.padding(horizontal = Dimens.grid2, vertical = Dimens.grid),
                    )
                }
                items(st.nodes, key = { it.id }) { node ->
                    val selected = st.prefs.viewNodeId == node.id ||
                        (st.filter as? io.rivethub.app.plane.ConversationFilter.Node)?.id == node.id
                    val nodeErr = st.nodeErrors[node.id]
                    ListRow(
                        title = node.name.ifBlank { node.id },
                        onClick = { vm.selectViewNode(node) },
                        meta = {
                            if (nodeErr != null) {
                                Pill(stringResource(R.string.node_error_badge), tone = io.rivethub.app.ui.components.PillTone.Warn)
                            }
                        },
                        trailing = {
                            Box(
                                Modifier
                                    .size(Dimens.accentDot)
                                    .clip(CircleShape)
                                    .background(if (node.online) colors.em else colors.red),
                            )
                            Spacer(Modifier.width(8.dp))
                            Pill(
                                if (node.online) stringResource(R.string.health_online) else stringResource(R.string.health_offline),
                                tone = if (node.online) io.rivethub.app.ui.components.PillTone.Em else io.rivethub.app.ui.components.PillTone.Dim,
                            )
                        },
                        dim = !selected && st.prefs.viewNodeId.isNotBlank(),
                    )
                }
            }
        }
    }
}
