package io.rivethub.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import io.rivethub.app.AppContainer
import io.rivethub.app.R
import io.rivethub.app.plane.agentRowSubtitle
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.DrawerSide
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
import io.rivethub.app.plane.drawerOpensMemoryScreen
import io.rivethub.app.plane.drawerTabRoute
import io.rivethub.app.plane.drawerWidthDp
import io.rivethub.app.plane.hubTabOnBack
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.AgentEditSheet
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
 * The ONE left navigation drawer (session-header slice: lifted out of the hub
 * content so MainActivity can host BOTH the hub and a chat session inside the
 * same ModalNavigationDrawer — the rail is reachable by ☰ or left-edge swipe
 * from every screen, Phil 2026-09-03). 2026-09-04: BOTH drawers run
 * `gesturesEnabled = false` (the two nested built-in gestures competed, so
 * the left swipe lost arbitration); ONE unified edge-swipe layer
 * ([unifiedDrawerSwipe], decision in `plane/DrawerSwipe.kt`, web
 * `lib/edge-swipe.ts` semantics) drives both DrawerStates — left bezel
 * opens/closes the rail, right bezel (session only, [rightDrawer] non-null)
 * opens/closes the history drawer, and a drag on an open drawer back toward
 * its bezel closes it. Drawer nav routes through `drawerTabRoute` identically
 * from the hub and from a session; [onNavTab] applies the tab and (from a
 * session) pops back to the hub. [content] receives the ☰ opener.
 */
@Composable
fun HubDrawer(
    vm: HubViewModel,
    onOpenChat: (AgentOpen) -> Unit,
    onNavTab: (HubTab) -> Unit,
    rightDrawer: DrawerState? = null,
    onOpenMemory: (() -> Unit)? = null,
    onOpenTasks: (() -> Unit)? = null,
    onOpenTask: ((taskId: String) -> Unit)? = null,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val st by vm.state.collectAsState()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var addAgentOpen by remember { mutableStateOf(false) }
    var editAgent by remember { mutableStateOf<AgentRow?>(null) }
    val tab = when (st.tab) {
        HubViewModel.Tab.Settings -> HubTab.Settings
        HubViewModel.Tab.Conversations -> HubTab.Conversations
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

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .unifiedDrawerSwipe(drawerState, rightDrawer, scope),
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
                    agents = st.agents,
                    agentsCollapsed = st.prefs.agentsCollapsed,
                    currentNodeName = currentName,
                    nodeSheet = nodeSheet,
                    exp = ExperimentalFlags(
                        files = st.prefs.expFiles,
                        tasks = st.prefs.expTasks,
                        workflows = st.prefs.expWorkflows,
                    ),
                    onClose = { closeDrawer() },
                    onNav = { dest ->
                        // Memory is its own screen (plane/DrawerNav.kt
                        // drawerOpensMemoryScreen), never a hub tab.
                        if (io.rivethub.app.plane.drawerOpensTasksScreen(dest)) onOpenTasks?.invoke()
                        else if (drawerOpensMemoryScreen(dest)) onOpenMemory?.invoke()
                        else drawerTabRoute(dest)?.let { onNavTab(it) }
                        closeDrawer()
                    },
                    onUnread = {
                        vm.setInboxOpen(true)
                        closeDrawer()
                    },
                    onToggleAgents = { vm.setAgentsCollapsed(!st.prefs.agentsCollapsed) },
                    onAddAgent = {
                        closeDrawer()
                        addAgentOpen = true
                    },
                    onAgentTap = { row ->
                        closeDrawer()
                        vm.openAgentAction(row, AgentAction.Tap)?.let(onOpenChat)
                    },
                    onAgentStartOver = { row ->
                        closeDrawer()
                        vm.openAgentAction(row, AgentAction.Replace)?.let(onOpenChat)
                    },
                    onAgentNew = { row ->
                        closeDrawer()
                        vm.openAgentAction(row, AgentAction.Plus)?.let(onOpenChat)
                    },
                    onAgentEdit = { row ->
                        if (row.online) {
                            closeDrawer()
                            editAgent = row
                        }
                    },
                    onAgentGoToNode = { row ->
                        vm.goToAgentNode(row)
                        closeDrawer()
                    },
                    onSelectNode = { row ->
                        if (row.selectable) {
                            vm.selectViewNode(row.id, row.name)
                            closeDrawer()
                        }
                    },
                    onRemoveNode = { row -> vm.removeSavedNode(row.denUrl) },
                    onSaveDiscovered = { row -> vm.addSavedNode(row.denUrl) },
                )
            },
        ) {
            content { openDrawer() }
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
                    val subtitle = agentRowSubtitle(agent).ifBlank { agent.nodeName }
                    Column(
                        Modifier
                            .sizeIn(minHeight = 44.dp)
                            .alpha(if (agent.online) 1f else 0.5f)
                            .clickable(enabled = agent.online) {
                                addAgentOpen = false
                                vm.openAgentAction(agent, AgentAction.Plus)?.let(onOpenChat)
                            }
                            .padding(8.dp),
                    ) {
                        Text(agent.name, color = colors.ink, style = RivetType.xs)
                        if (subtitle.isNotBlank()) {
                            Text(subtitle, color = colors.inkDim, style = RivetType.mono10)
                        }
                    }
                }
            }
        }
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

/**
 * The RIGHT history drawer in a session (web chat.tsx:585-626): an end-side
 * ModalNavigationDrawer — the RTL wrap is the standard Compose end-drawer
 * pattern — whose content is the same D1a [ConversationsPane] the hub shows
 * (filter · rows · `+ new`), at the left rail's width rule (`drawerWidthDp`;
 * web `w-64`, sidebar.tsx:186-197) with `border-l border-line bg-panel`
 * (chat.tsx:612) and the `bg-bg/70` scrim (chat.tsx:600). 2026-09-04:
 * `gesturesEnabled = false` — [state] is lifted to MainActivity and shared
 * with [HubDrawer]'s unified edge-swipe layer, which owns the right-bezel
 * open and the drag-back close (plane/DrawerSwipe.kt). The history button in
 * the session header opens it via the [content] opener. Row tap / `+ new`
 * close it; MainActivity switches the session. [currentSessionKey] is the
 * open chat's key; the pane highlights and scrolls to it each time the drawer
 * starts opening (by button or by edge swipe — both move [state]).
 */
@Composable
fun HistoryDrawer(
    vm: HubViewModel,
    state: DrawerState,
    currentSessionKey: String?,
    onOpenRow: (LocatedChatItem) -> Unit,
    onOpenChat: (AgentOpen) -> Unit,
    content: @Composable (openHistory: () -> Unit) -> Unit,
) {
    val scope = rememberCoroutineScope()
    fun openHistory() { scope.launch { state.open() } }
    fun closeHistory() { scope.launch { state.close() } }
    var openTick by remember { mutableIntStateOf(0) }
    LaunchedEffect(state) {
        snapshotFlow { state.targetValue }.collect { if (it == DrawerValue.Open) openTick += 1 }
    }
    val colors = RivetTheme.colors
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val drawerWidth = drawerWidthDp(maxWidth.value).dp
            ModalNavigationDrawer(
                drawerState = state,
                gesturesEnabled = false,
                scrimColor = colors.bg.copy(alpha = 0.7f),
                drawerContent = {
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                        Column(
                            Modifier
                                .width(drawerWidth)
                                .fillMaxHeight()
                                .background(colors.panel)
                                .drawStartBorder(colors.line),
                        ) {
                            ConversationsPane(
                                vm = vm,
                                currentSessionKey = currentSessionKey,
                                openTick = openTick,
                                onOpenRow = { row ->
                                    closeHistory()
                                    onOpenRow(row)
                                },
                                onOpenChat = { open ->
                                    closeHistory()
                                    onOpenChat(open)
                                },
                                modifier = Modifier
                                    .fillMaxSize()
                                    .statusBarsPadding(),
                            )
                        }
                    }
                },
            ) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    content { openHistory() }
                }
            }
        }
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

private fun Modifier.drawStartBorder(color: Color): Modifier =
    drawBehind {
        val stroke = 1.dp.toPx()
        drawLine(color, Offset(stroke / 2f, 0f), Offset(stroke / 2f, size.height), stroke)
    }

/**
 * The ONE unified edge-swipe layer for both drawers (2026-09-04). Sits on
 * [HubDrawer]'s root — an ancestor of both ModalNavigationDrawers — and
 * observes events on `PointerEventPass.Initial`, so drags that start on an
 * OPEN drawer panel still reach it (that is what makes swipe-to-close work
 * with `gesturesEnabled = false`). The down is recorded WITHOUT consuming it,
 * so taps, the ☰/history buttons, scrim tap-to-close, and system Back keep
 * working; each move is evaluated by the pure `decideDrawerSwipe`
 * (`leftState`/`rightState` read live), and only once it fires does the layer
 * consume the rest of the gesture (so the drawer drag cannot start a text
 * selection) and launch the open/close — once per gesture.
 */
private fun Modifier.unifiedDrawerSwipe(
    leftState: DrawerState,
    rightState: DrawerState?,
    scope: CoroutineScope,
): Modifier = pointerInput(rightState != null) {
    val zone = EDGE_ZONE_DP.dp.toPx()
    val travel = EDGE_TRAVEL_DP.dp.toPx()
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val width = size.width.toFloat()
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
                viewportWidth = width,
                sessionOpen = rightState != null,
                leftOpen = leftState.isOpen,
                rightOpen = rightState?.isOpen == true,
                zone = zone,
                travel = travel,
            )
            if (action != null) {
                decided = true
                change.consume()
                scope.launch {
                    when (action) {
                        is DrawerSwipeAction.Open -> when (action.side) {
                            DrawerSide.Left -> leftState.open()
                            DrawerSide.Right -> rightState?.open()
                        }
                        is DrawerSwipeAction.Close -> when (action.side) {
                            DrawerSide.Left -> leftState.close()
                            DrawerSide.Right -> rightState?.close()
                        }
                    }
                }
            }
        }
    }
}
