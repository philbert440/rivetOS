package io.rivethub.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.R
import io.rivethub.app.plane.agentRowSubtitle
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.AgentSheetAction
import io.rivethub.app.plane.DrawerDest
import io.rivethub.app.plane.DrawerSwipeAction
import io.rivethub.app.plane.EDGE_TRAVEL_DP
import io.rivethub.app.plane.EDGE_ZONE_DP
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.InboxEntry
import io.rivethub.app.plane.InboxRoute
import io.rivethub.app.plane.inboxRoute
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.NodeSheetInput
import io.rivethub.app.plane.buildNodeSheet
import io.rivethub.app.plane.ExperimentalFlags
import io.rivethub.app.plane.decideDrawerSwipe
import io.rivethub.app.plane.drawerFooterDest
import io.rivethub.app.plane.drawerOpensMemoryScreen
import io.rivethub.app.plane.drawerTabRoute
import io.rivethub.app.plane.drawerWidthDp
import io.rivethub.app.plane.hubTabOnBack
import io.rivethub.app.plane.entryAnsweredFor
import io.rivethub.app.plane.nodeDots
import io.rivethub.app.plane.statusActiveNodeId
import io.rivethub.app.plane.statusEntryNodeId
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.AgentEditSheet
import io.rivethub.app.ui.components.AgentsPickerSheet
import io.rivethub.app.ui.components.RivetDrawerContent
import io.rivethub.app.ui.components.RivetModalSheet
import io.rivethub.app.ui.components.RivetButton
import io.rivethub.app.ui.components.RivetButtonSize
import io.rivethub.app.ui.components.RivetButtonVariant
import io.rivethub.app.ui.components.TimeFmt
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The ONE navigation drawer (drawer v2, UX-SPEC §2, slice U2b — there is no
 * right drawer). The hub, a chat session and the Memory screens all live
 * inside this same left ModalNavigationDrawer, reachable by ☰ (or the chat
 * header's history button) and by a left-edge swipe from every screen. The
 * drawer runs `gesturesEnabled = false`; [unifiedDrawerSwipe] (decision in
 * `plane/DrawerSwipe.kt`, web `lib/edge-swipe.ts` semantics) owns the
 * left-bezel open and the drag-back close.
 *
 * The drawer body is the conversation list ([ConversationsPane]).
 * [currentSessionKey] is the open chat's key (null off a chat); the pane
 * highlights and scrolls to it each time the drawer starts opening — the
 * open tick is derived from this drawer's own state, so the button and the
 * edge swipe both count. Row tap / `+ new` close the drawer and hand off to
 * [onOpenRow] / [onOpenChat]. Footer buttons route Agents → the agents
 * picker sheet, Tasks → the flagged route (inert until it exists), Memory →
 * [onOpenMemory], Settings → the settings tab via [onNavTab].
 *
 * The node status strip derives from state already held — hub state here,
 * plus the open chat's socket ([chatWs]) and node ([chatNodeDenUrl]) when a
 * chat is open (`plane/NodeStatus.kt`). A tap is one `vm.refresh()`; nothing
 * polls.
 */
@Composable
fun HubDrawer(
    vm: HubViewModel,
    currentSessionKey: String?,
    onOpenChat: (AgentOpen) -> Unit,
    onOpenRow: (LocatedChatItem) -> Unit,
    onNavTab: (HubTab) -> Unit,
    onOpenMemory: (() -> Unit)? = null,
    onOpenTasks: (() -> Unit)? = null,
    onOpenTask: ((taskId: String) -> Unit)? = null,
    chatWs: WsStatus? = null,
    chatNodeDenUrl: String? = null,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val st by vm.state.collectAsState()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var inboxOpen by remember { mutableStateOf(false) }
    var agentsPickerOpen by remember { mutableStateOf(false) }
    var editAgent by remember { mutableStateOf<AgentRow?>(null) }
    var openTick by remember { mutableIntStateOf(0) }
    LaunchedEffect(drawerState) {
        snapshotFlow { drawerState.targetValue }.collect { if (it == DrawerValue.Open) openTick += 1 }
    }
    val tab = when (st.tab) {
        HubViewModel.Tab.Settings -> HubTab.Settings
        HubViewModel.Tab.Conversations -> HubTab.Conversations
    }
    fun openDrawer() { scope.launch { drawerState.open() } }
    fun closeDrawer() { scope.launch { drawerState.close() } }
    fun navTo(dest: DrawerDest) {
        // Memory is its own screen (plane/DrawerNav.kt
        // drawerOpensMemoryScreen), never a hub tab.
        if (io.rivethub.app.plane.drawerOpensTasksScreen(dest)) onOpenTasks?.invoke()
        else if (drawerOpensMemoryScreen(dest)) onOpenMemory?.invoke()
        else drawerTabRoute(dest)?.let { onNavTab(it) }
        closeDrawer()
    }
    val colors = RivetTheme.colors
    val exp = ExperimentalFlags(
        files = st.prefs.expFiles,
        tasks = st.prefs.expTasks,
        workflows = st.prefs.expWorkflows,
    )
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
    val dots = nodeDots(
        entryNodeId = statusEntryNodeId(st.nodes, st.prefs.entryUrl),
        nodes = st.nodes,
        nodeErrors = st.nodeErrors,
        registryOpen = st.registryOpen,
        activeNodeId = statusActiveNodeId(st.nodes, chatNodeDenUrl, st.prefs.viewNodeId, st.prefs.entryUrl),
        chatWs = chatWs,
        discovering = st.loading,
        entryAnswered = entryAnsweredFor(st.entryAnswer, st.prefs.entryUrl, st.identityGen),
    )

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .unifiedDrawerSwipe(drawerState, scope),
    ) {
        val drawerWidth = drawerWidthDp(maxWidth.value).dp
        ModalNavigationDrawer(
            drawerState = drawerState,
            gesturesEnabled = false,
            scrimColor = colors.bg.copy(alpha = 0.7f),
            drawerContent = {
                RivetDrawerContent(
                    width = drawerWidth,
                    tab = tab,
                    unread = st.unread,
                    dots = dots,
                    currentNodeName = currentName,
                    nodeSheet = nodeSheet,
                    exp = exp,
                    onClose = { closeDrawer() },
                    onNav = { dest -> navTo(dest) },
                    onFooter = { action ->
                        val dest = drawerFooterDest(action)
                        if (dest != null) {
                            navTo(dest)
                        } else {
                            closeDrawer()
                            agentsPickerOpen = true
                        }
                    },
                    onUnread = {
                        vm.setInboxOpen(true)
                        closeDrawer()
                    },
                    onRefreshStatus = { vm.refresh() },
                    onSelectNode = { row ->
                        if (row.selectable) {
                            vm.selectViewNode(row.id, row.name)
                            closeDrawer()
                        }
                    },
                    onRemoveNode = { row -> vm.removeSavedNode(row.denUrl) },
                    onSaveDiscovered = { row -> vm.addSavedNode(row.denUrl) },
                ) {
                    ConversationsPane(
                        vm = vm,
                        currentSessionKey = currentSessionKey,
                        openTick = openTick,
                        onOpenRow = { row ->
                            closeDrawer()
                            onOpenRow(row)
                        },
                        onOpenChat = { open ->
                            closeDrawer()
                            onOpenChat(open)
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            },
        ) {
            content { openDrawer() }
        }
    }

    // Back closes the open (or opening) drawer before anything underneath
    // handles it — nav.pop() in MainActivity, the Settings → Conversations
    // tab step in HubScreen, a screen's own handler. The dispatcher runs the
    // most recently ADDED enabled callback, so this handler is composed after
    // the drawer's content and re-added on every open (key(openTick)): it is
    // newer than any handler the content registered before this open, even
    // one that appeared after an earlier open. Sheets opened from the drawer are their own
    // windows and dismiss on Back first.
    key(openTick) {
        BackHandler(enabled = drawerState.isOpen || drawerState.targetValue == DrawerValue.Open) {
            closeDrawer()
        }
    }

    if (agentsPickerOpen) {
        AgentsPickerSheet(
            agents = st.agents,
            onDismiss = { agentsPickerOpen = false },
            onPick = { row ->
                agentsPickerOpen = false
                vm.openAgentAction(row, AgentAction.Plus)?.let(onOpenChat)
            },
            onAction = { row, action ->
                when (action) {
                    AgentSheetAction.StartOver -> vm.openAgentAction(row, AgentAction.Replace)?.let(onOpenChat)
                    AgentSheetAction.New -> vm.openAgentAction(row, AgentAction.Plus)?.let(onOpenChat)
                    AgentSheetAction.Edit -> { editAgent = row }
                    AgentSheetAction.GoToNode -> vm.goToAgentNode(row)
                }
                agentsPickerOpen = false
            },
        )
    }

    editAgent?.let { row ->
        AgentEditSheet(
            row = row,
            directoryRoot = st.directoryRoot,
            sheetFor = { denUrl -> vm.sheetFor(denUrl, row.harnessId) },
            onSave = { fields, onDone ->
                vm.saveAgent(row, fields) { ok ->
                    if (ok) editAgent = null
                    onDone(ok)
                }
            },
            onDismiss = { editAgent = null },
        )
    }

    if (st.inboxOpen) {
        InboxSheet(
            entries = st.inbox,
            onDismiss = { vm.setInboxOpen(false) },
            onClear = { vm.clearInbox() },
            onRow = { entry ->
                vm.markInboxRead(entry.id)
                when (val route = inboxRoute(entry)) {
                    is InboxRoute.Task -> onOpenTask?.let { open ->
                        vm.setInboxOpen(false)
                        open(route.taskId)
                        true
                    } ?: false
                    null -> true
                }
            },
        )
    }
}

/**
 * The notifications inbox (UX-SPEC §6): newest first, unread dot, relative
 * time, Clear. [onRow] returns false when the row's destination is not in
 * this build (no Tasks screen yet) — the sheet then shows a one-line strip
 * instead of navigating.
 */
@Composable
private fun InboxSheet(
    entries: List<InboxEntry>,
    onDismiss: () -> Unit,
    onClear: () -> Unit,
    onRow: (InboxEntry) -> Boolean,
) {
    val colors = RivetTheme.colors
    var strip by remember { mutableStateOf<String?>(null) }
    val unavailable = stringResource(R.string.inbox_task_unavailable)
    RivetModalSheet(onDismiss = onDismiss) {
        Row(
            Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.inbox_title),
                color = colors.em,
                style = RivetType.sm,
                modifier = Modifier.weight(1f).padding(vertical = 8.dp),
            )
            if (entries.isNotEmpty()) {
                RivetButton(
                    text = stringResource(R.string.inbox_clear),
                    onClick = {
                        strip = null
                        onClear()
                    },
                    variant = RivetButtonVariant.Ghost,
                    size = RivetButtonSize.Sm,
                    textColor = colors.inkDim,
                )
            }
        }
        strip?.let {
            Text(
                it,
                color = colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.panel)
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
        if (entries.isEmpty()) {
            Text(
                stringResource(R.string.inbox_empty),
                color = colors.inkDim,
                style = RivetType.xs,
                modifier = Modifier.padding(8.dp),
            )
        } else {
            Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding()) {
                entries.forEach { entry ->
                    InboxRow(entry) {
                        strip = if (onRow(entry)) null else unavailable
                    }
                }
            }
        }
    }
}

@Composable
private fun InboxRow(entry: InboxEntry, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    // The unread dot is colour-only; say it for TalkBack too.
    val unreadLabel = stringResource(R.string.inbox_row_unread)
    Row(
        Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .semantics(mergeDescendants = true) {
                if (!entry.read) stateDescription = unreadLabel
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 6.dp, end = 8.dp).size(6.dp)) {
            if (!entry.read) {
                Box(Modifier.fillMaxSize().clip(CircleShape).background(colors.em))
            }
        }
        Column(Modifier.weight(1f)) {
            Text(entry.title, color = colors.ink, style = RivetType.xs, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (entry.body.isNotBlank()) {
                Text(entry.body, color = colors.inkDim, style = RivetType.xs, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(
            TimeFmt.listTime(entry.atMs),
            color = colors.inkDim,
            style = RivetType.mono10,
            modifier = Modifier.padding(start = 8.dp, top = 2.dp),
        )
    }
}

/** The hub content — the launch surface (Conversations tab) or Settings —
 *  inside [HubDrawer]. 2026-09-04: the Conversations tab is no longer a
 *  full-screen list; it renders [ChatLaunchScreen] while MainActivity's
 *  launch resolution opens the session the phone's home actually is. */
@Composable
fun HubScreen(
    vm: HubViewModel,
    c: AppContainer,
    onNew: () -> Unit,
    onOpenGallery: () -> Unit,
    onForget: () -> Unit,
    onOpenDrawer: () -> Unit,
) {
    val st by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
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
    Column(Modifier.fillMaxSize()) {
        when (st.tab) {
            HubViewModel.Tab.Conversations -> ChatLaunchScreen(onOpenDrawer = onOpenDrawer, onNew = onNew)
            HubViewModel.Tab.Settings -> SettingsScreen(
                c = c,
                vm = vm,
                onForget = onForget,
                onOpenGallery = onOpenGallery,
                onOpenDrawer = onOpenDrawer,
            )
        }
    }
}

/**
 * The edge-swipe layer for the one left drawer. Sits on [HubDrawer]'s root —
 * an ancestor of the ModalNavigationDrawer — and observes events on
 * `PointerEventPass.Initial`, so it sees every drag even with
 * `gesturesEnabled = false`. While the drawer is open only a drag that
 * starts on the scrim (right of the sheet) closes it (fix1); a drag on the
 * sheet is never consumed, so row swipe-to-archive keeps working. The down is recorded WITHOUT consuming it, so
 * taps, the ☰ button, scrim tap-to-close, and system Back keep working; each
 * move is evaluated by the pure `decideDrawerSwipe` ([state] read live), and
 * only once it fires does the layer consume the rest of the gesture (so the
 * drawer drag cannot start a text selection) and launch the open/close —
 * once per gesture.
 */
private fun Modifier.unifiedDrawerSwipe(
    state: DrawerState,
    scope: CoroutineScope,
): Modifier = pointerInput(state) {
    val zone = EDGE_ZONE_DP.dp.toPx()
    val travel = EDGE_TRAVEL_DP.dp.toPx()
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        // The open sheet's width, from this layer's own size (it spans the
        // drawer host): a close drag must start right of it, on the scrim.
        val sheet = drawerWidthDp(size.width.toDp().value).dp.toPx()
        var decided = false
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.none { it.pressed }) break
            val change = event.changes.firstOrNull { it.id == down.id } ?: continue
            if (decided) {
                if (change.positionChanged()) change.consume()
                continue
            }
            val action = decideDrawerSwipe(
                startX = down.position.x,
                dx = change.position.x - down.position.x,
                dy = change.position.y - down.position.y,
                leftOpen = state.isOpen,
                sheetWidth = sheet,
                zone = zone,
                travel = travel,
            )
            if (action != null) {
                decided = true
                change.consume()
                scope.launch {
                    when (action) {
                        is DrawerSwipeAction.Open -> state.open()
                        is DrawerSwipeAction.Close -> state.close()
                    }
                }
            }
        }
    }
}
