package io.rivethub.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.R
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.NodeSheetInput
import io.rivethub.app.plane.buildNodeSheet
import io.rivethub.app.plane.hubTabOf
import io.rivethub.app.plane.hubTabOnBack
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.RivetDrawerContent
import io.rivethub.app.ui.components.RivetModalSheet
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.launch

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
    LaunchedEffect(Unit) { vm.refresh() }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var inboxOpen by remember { mutableStateOf(false) }
    var addAgentOpen by remember { mutableStateOf(false) }
    val tab = when (st.tab) {
        HubViewModel.Tab.Settings -> HubTab.Settings
        HubViewModel.Tab.Conversations -> HubTab.Conversations
    }
    BackHandler(enabled = hubTabOnBack(tab) != null) {
        when (hubTabOnBack(tab)) {
            HubTab.Conversations -> vm.setTab(HubViewModel.Tab.Conversations)
            HubTab.Settings, null -> Unit
        }
    }
    fun openDrawer() { scope.launch { drawerState.open() } }
    fun closeDrawer() { scope.launch { drawerState.close() } }
    val colors = RivetTheme.colors
    val nodeSheet = remember(
        st.prefs.entryUrl,
        st.prefs.extraNodes,
        st.nodes,
        st.prefs.viewNodeId,
        st.nodeErrors,
        st.errorKind,
    ) {
        buildNodeSheet(
            entryUrl = st.prefs.entryUrl,
            extraUrls = st.prefs.extraNodes,
            nodes = st.nodes.map {
                NodeSheetInput(it.id, it.name.ifBlank { it.id }, it.denUrl, it.sessions, it.online)
            },
            viewNodeId = st.prefs.viewNodeId,
            nodeErrors = st.nodeErrors,
            meshUnavailable = st.errorKind != null && st.nodes.isEmpty(),
        )
    }
    val currentNode = st.nodes.find { it.id == st.prefs.viewNodeId }
        ?: st.nodes.find { it.denUrl.trimEnd('/') == st.prefs.entryUrl.trim().trimEnd('/') }
        ?: st.nodes.firstOrNull()
    val currentName = currentNode?.name?.ifBlank { currentNode.id } ?: st.prefs.entryUrl.ifBlank { "—" }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val drawerWidth = if (maxWidth < 360.dp) maxWidth * 0.85f else Dimens.drawerWidth
        ModalNavigationDrawer(
            drawerState = drawerState,
            scrimColor = colors.bg.copy(alpha = 0.7f),
            drawerContent = {
                RivetDrawerContent(
                    width = drawerWidth,
                    tab = tab,
                    unread = st.inbox.size,
                    agents = st.agents,
                    agentsCollapsed = st.prefs.agentsCollapsed,
                    currentNodeName = currentName,
                    nodeSheet = nodeSheet,
                    onClose = { closeDrawer() },
                    onNav = { dest ->
                        hubTabOf(dest)?.let { next ->
                            vm.setTab(
                                when (next) {
                                    HubTab.Conversations -> HubViewModel.Tab.Conversations
                                    HubTab.Settings -> HubViewModel.Tab.Settings
                                },
                            )
                        }
                        closeDrawer()
                    },
                    onUnread = {
                        inboxOpen = true
                        closeDrawer()
                    },
                    onToggleAgents = { vm.setAgentsCollapsed(!st.prefs.agentsCollapsed) },
                    onAddAgent = {
                        closeDrawer()
                        addAgentOpen = true
                    },
                    onAgentTap = { row ->
                        closeDrawer()
                        onOpenChat(vm.openAgentAction(row, AgentAction.Tap))
                    },
                    onAgentStartOver = { row ->
                        closeDrawer()
                        onOpenChat(vm.openAgentAction(row, AgentAction.Replace))
                    },
                    onAgentNew = { row ->
                        closeDrawer()
                        onOpenChat(vm.openAgentAction(row, AgentAction.Plus))
                    },
                    onSelectNode = { row ->
                        if (row.selectable) {
                            vm.selectViewNode(row.id, row.name)
                            closeDrawer()
                        }
                    },
                    onRemoveNode = { row -> vm.removeSavedNode(row.denUrl) },
                    onSaveDiscovered = { row -> vm.addSavedNode(row.denUrl) },
                    modifier = Modifier.statusBarsPadding().navigationBarsPadding(),
                )
            },
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding(),
            ) {
                when (st.tab) {
                    HubViewModel.Tab.Conversations -> ConversationsScreen(
                        vm = vm,
                        onOpenRow = onOpenRow,
                        onOpenChat = onOpenChat,
                        onOpenDrawer = { openDrawer() },
                    )
                    HubViewModel.Tab.Settings -> SettingsScreen(
                        c = c,
                        vm = vm,
                        onForget = onForget,
                        onOpenGallery = onOpenGallery,
                        onOpenDrawer = { openDrawer() },
                    )
                }
            }
        }
    }

    if (addAgentOpen) {
        RivetModalSheet(onDismiss = { addAgentOpen = false }) {
            Text(
                stringResource(R.string.pick_agent),
                color = colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier.padding(8.dp),
            )
            if (st.agents.isEmpty()) {
                Text(
                    stringResource(R.string.empty_agents),
                    color = colors.inkDim,
                    style = RivetType.xs,
                    modifier = Modifier.padding(8.dp),
                )
            } else {
                st.agents.forEach { agent ->
                    Text(
                        "${agent.name} · ${agent.nodeName}",
                        color = colors.ink,
                        style = RivetType.xs,
                        modifier = Modifier
                            .sizeIn(minHeight = 44.dp)
                            .clickable {
                                addAgentOpen = false
                                onOpenChat(vm.openAgentAction(agent, AgentAction.Plus))
                            }
                            .padding(8.dp),
                    )
                }
            }
        }
    }

    if (inboxOpen) {
        RivetModalSheet(onDismiss = { inboxOpen = false }) {
            Text(
                stringResource(R.string.inbox_title),
                color = colors.em,
                style = RivetType.sm,
                modifier = Modifier.padding(8.dp),
            )
            if (st.inbox.isEmpty()) {
                Text(
                    stringResource(R.string.empty_inbox),
                    color = colors.inkDim,
                    style = RivetType.xs,
                    modifier = Modifier.padding(8.dp),
                )
            } else {
                st.inbox.forEach { item ->
                    Text(item.text, color = colors.ink, style = RivetType.sm, modifier = Modifier.padding(8.dp))
                }
            }
        }
    }
}
