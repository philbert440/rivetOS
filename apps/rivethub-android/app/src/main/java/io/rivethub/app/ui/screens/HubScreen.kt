package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import io.rivethub.app.AppContainer
import io.rivethub.app.R
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.BottomRail
import io.rivethub.app.ui.components.RailItem
import io.rivethub.app.ui.theme.RivetTheme

@Composable
fun HubScreen(
    vm: HubViewModel,
    c: AppContainer,
    onOpenChat: (AgentOpen) -> Unit,
    onOpenRow: (LocatedChatItem) -> Unit,
    onOpenGallery: () -> Unit,
    onForget: () -> Unit,
) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    val chats = stringResource(R.string.rail_chats)
    val agents = stringResource(R.string.rail_agents)
    val nodes = stringResource(R.string.rail_nodes)
    val settings = stringResource(R.string.rail_settings)
    val more = stringResource(R.string.rail_more)
    val rail = listOf(
        RailItem("chats", chats, Icons.Outlined.ChatBubbleOutline),
        RailItem("agents", agents, Icons.Outlined.SmartToy),
        RailItem("nodes", nodes, Icons.Outlined.Dns),
        RailItem("settings", settings, Icons.Outlined.Settings),
        RailItem("more", more, Icons.Outlined.MoreHoriz, enabled = false),
    )
    val active = when (st.tab) {
        HubViewModel.Tab.Conversations -> "chats"
        HubViewModel.Tab.Agents -> "agents"
        HubViewModel.Tab.Nodes -> "nodes"
        HubViewModel.Tab.Settings -> "settings"
    }
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Column(Modifier.weight(1f)) {
            when (st.tab) {
                HubViewModel.Tab.Conversations -> ConversationsScreen(
                    vm = vm,
                    onOpenRow = onOpenRow,
                    onNew = { onOpenChat(vm.newConversation()) },
                )
                HubViewModel.Tab.Agents -> AgentsScreen(
                    vm = vm,
                    onOpen = { row, action -> onOpenChat(vm.openAgentAction(row, action)) },
                )
                HubViewModel.Tab.Nodes -> NodesScreen(vm = vm)
                HubViewModel.Tab.Settings -> SettingsScreen(
                    c = c,
                    vm = vm,
                    onForget = onForget,
                    onOpenGallery = onOpenGallery,
                )
            }
        }
        BottomRail(
            items = rail,
            active = active,
            onSelect = { id ->
                when (id) {
                    "chats" -> vm.setTab(HubViewModel.Tab.Conversations)
                    "agents" -> vm.setTab(HubViewModel.Tab.Agents)
                    "nodes" -> vm.setTab(HubViewModel.Tab.Nodes)
                    "settings" -> vm.setTab(HubViewModel.Tab.Settings)
                }
            },
        )
    }
}
