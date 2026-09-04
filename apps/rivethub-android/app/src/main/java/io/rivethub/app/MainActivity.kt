package io.rivethub.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.NewConversationAction
import io.rivethub.app.plane.newConversationAction
import io.rivethub.app.plane.ChatHomeNav
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.LaunchCandidate
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.NarrowLaunchTarget
import io.rivethub.app.plane.chatHomeNav
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.findChatItem
import io.rivethub.app.plane.isDraftSessionId
import io.rivethub.app.plane.narrowLaunchTarget
import io.rivethub.app.plane.persistableLastSession
import io.rivethub.app.plane.resumedSessionStale
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.MemoryViewModel
import io.rivethub.app.ui.Nav
import io.rivethub.app.ui.Screen
import io.rivethub.app.ui.components.ComponentGallery
import io.rivethub.app.ui.screens.EnrollScreen
import io.rivethub.app.ui.screens.HarnessChatScreen
import io.rivethub.app.ui.screens.HistoryDrawer
import io.rivethub.app.ui.screens.HubDrawer
import io.rivethub.app.ui.screens.HubScreen
import io.rivethub.app.ui.screens.MemoryScreen
import io.rivethub.app.ui.screens.MemoryTopicScreen
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.ThemeMode
import io.rivethub.app.ui.theme.blueprintGrid

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        requestLocalNetworkAccess()
        val container = (application as BotsApp).container
        setContent {
            val prefs by container.settings.prefs.collectAsState(initial = null)
            val mode = when (prefs?.themeMode) {
                "light" -> ThemeMode.Light
                "dark" -> ThemeMode.Dark
                else -> ThemeMode.System
            }
            // D2-1: status/nav bar icon colour follows the in-app theme, not
            // just the OS mode (light icons on the dark theme and vice versa).
            val systemDark = isSystemInDarkTheme()
            val dark = when (mode) {
                ThemeMode.Light -> false
                ThemeMode.Dark -> true
                ThemeMode.System -> systemDark
            }
            SideEffect {
                WindowInsetsControllerCompat(window, window.decorView).run {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            RivetTheme(mode) { App(container, openStream = { uri -> contentResolver.openInputStream(uri) }) }
        }
    }

    /**
     * Android 16+ Local Network Protection gates RFC1918 traffic behind
     * ACCESS_LOCAL_NETWORK. Referenced by string so older platforms (and the
     * emulator image) don't need the constant; no-op when already granted or
     * the permission doesn't exist.
     */
    private fun requestLocalNetworkAccess() {
        val perm = "android.permission.ACCESS_LOCAL_NETWORK"
        runCatching { packageManager.getPermissionInfo(perm, 0) }.getOrNull() ?: return
        if (checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
            .launch(perm)
    }
}

/**
 * ViewModel stores scoped to back-stack entries, held by an activity-scoped
 * ViewModel so they survive configuration changes and are cleared — sockets
 * and all — exactly when the activity is finished.
 */
internal class ScreenStores : ViewModel() {
    private class Owner : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
    private val owners = HashMap<String, Owner>()
    fun owner(key: String): ViewModelStoreOwner = owners.getOrPut(key) { Owner() }
    fun retainOnly(keys: Set<String>) {
        (owners.keys - keys).forEach { owners.remove(it)?.viewModelStore?.clear() }
    }
    fun clearAll() { owners.values.forEach { it.viewModelStore.clear() }; owners.clear() }
    override fun onCleared() = clearAll()
}

/** Quiet window (ms) with no new hub items/agents before chat-first launch
 *  fires — the mesh loads node-by-node and `loading` never cleanly settles. */
private const val LAUNCH_SETTLE_MS = 600L

private fun Screen.storeKey(): String? = when (this) {
    is Screen.Chat -> "chat:${nodeDenUrl}:$sessionKey"
    else -> null
}

@Composable
fun App(c: AppContainer, openStream: (android.net.Uri) -> java.io.InputStream? = { null }) {
    val prefs by c.settings.prefs.collectAsState(initial = null)
    val p = prefs
    val colors = RivetTheme.colors
    if (p == null) {
        Box(Modifier.fillMaxSize().background(colors.bg).blueprintGrid(colors.gridLine))
        return
    }
    // Home IS the chat surface (Phil 2026-09-04: the conversations list is
    // not an app screen; it lives only in the right history drawer). Instant
    // resume: a persisted last session (plane/LaunchSession.kt LastSession,
    // written by openChat) starts the nav stack straight on Screen.Chat —
    // before the mesh loads; the session screen's own loading covers the
    // transcript. No pointer → Screen.Hub, whose Conversations tab is the
    // launch SURFACE (ChatLaunchScreen) until the pick/new resolution below
    // opens a session.
    val nav = remember {
        Nav(
            when {
                !(c.identity.hasIdentity() && p.entryUrl.isNotBlank() && p.onboarded) -> Screen.Enroll
                p.lastSessionKey.isNotBlank() && p.lastSessionNode.isNotBlank() -> Screen.Chat(
                    sessionKey = p.lastSessionKey,
                    nodeDenUrl = p.lastSessionNode,
                    harnessId = null,
                    title = p.lastSessionKey,
                    draft = isDraftSessionId(p.lastSessionKey),
                )
                else -> Screen.Hub
            },
        )
    }
    // The session key the stack root was instant-resumed from (null when the
    // launch went through the surface). Used by the stale-resume fallback
    // below — only a root Chat can have come from the pointer.
    var resumedKey by remember { mutableStateOf((nav.stack.firstOrNull() as? Screen.Chat)?.sessionKey) }
    val scope = rememberCoroutineScope()
    val stores: ScreenStores = viewModel(key = "screen-stores")
    val hubVm: HubViewModel = viewModel(key = "hub") { HubViewModel(c) }
    val memoryVm: MemoryViewModel = viewModel(key = "memory") { MemoryViewModel(c) }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val liveKeys = nav.stack.mapNotNull { it.storeKey() }.toSet()
    LaunchedEffect(liveKeys) { stores.retainOnly(liveKeys) }

    val newTitle = stringResource(R.string.new_conversation)

    // Opening a chat from the hub/launch surface PUSHES (replaceAll at launch
    // resolution, so the home session IS the stack root); from inside a
    // session (the right history drawer, or a drawer agent row) it REPLACES
    // the open session — web row tap switches the active session in place.
    // Every open persists the instant-resume pointer (drafts excepted —
    // plane/LaunchSession.kt persistableLastSession).
    fun openChat(chat: Screen.Chat, replaceAll: Boolean = false) {
        persistableLastSession(chat.sessionKey, chat.nodeDenUrl, chat.draft)?.let { last ->
            scope.launch { c.settings.setLastSession(last.key, last.nodeDenUrl) }
        }
        if (replaceAll) {
            nav.replaceAll(chat)
            return
        }
        if (nav.current is Screen.Chat) nav.pop()
        nav.push(chat)
    }
    fun openChatScreen(open: AgentOpen, replaceAll: Boolean = false) {
        val located = hubVm.state.value.items
        val hit = findChatItem(located.map { it.item }, open.sessionId)
        val title = when {
            open.draft -> newTitle
            hit != null -> displayTitle(hit, hubVm.state.value.titleOverrides)
            else -> open.sessionId
        }
        openChat(
            Screen.Chat(
                sessionKey = open.sessionId,
                nodeDenUrl = open.nodeDenUrl,
                harnessId = open.harnessId,
                title = title,
                draft = open.draft,
                model = open.model,
                effort = open.effort,
                agentId = open.agentId,
            ),
            replaceAll,
        )
    }
    fun openRowScreen(row: LocatedChatItem, replaceAll: Boolean = false) {
        openChat(
            Screen.Chat(
                sessionKey = row.item.key,
                nodeDenUrl = row.nodeDenUrl,
                harnessId = row.item.harnessId,
                title = displayTitle(row.item, hubVm.state.value.titleOverrides),
                draft = row.item.kind == ChatItemKind.DRAFT || isDraftSessionId(row.item.key),
                model = row.item.model.orEmpty(),
                agentId = hubVm.agentForSession(row.item.key).orEmpty(),
            ),
            replaceAll,
        )
    }
    // Open the current agent's thread as the compose surface (never a list).
    // Tap, not Plus: Tap resumes the agent's pinned draft if one exists (a
    // pinned draft is excluded from the pick, so Plus would mint a duplicate)
    // and otherwise mints one. Needs a current agent; with none the launch
    // surface keeps showing until one can be chosen. Shared by the launch
    // resolution below and the launch surface's New-conversation button.
    fun openNewDraft() {
        val st = hubVm.state.value
        when (val act = newConversationAction(st.prefs.currentAgentId, st.agents.map { it.agentId })) {
            is NewConversationAction.ForAgent -> {
                val agent = st.agents.find { it.agentId == act.agentId } ?: return
                openChatScreen(hubVm.openAgentAction(agent, AgentAction.Tap), replaceAll = true)
            }
            NewConversationAction.PickAgent -> Unit
        }
    }
    // Left-nav Conversations → the chat home, never a list screen (Phil
    // 2026-09-04): the ACTIVE session when one is on the stack; otherwise the
    // launch surface, whose effect below resolves the pick/new.
    fun routeChatHome() {
        when (chatHomeNav(nav.current is Screen.Chat, nav.stack.any { it is Screen.Chat })) {
            ChatHomeNav.AlreadyHome -> Unit
            ChatHomeNav.PopToSession -> nav.popTo { it is Screen.Chat }
            ChatHomeNav.Resolve -> {
                hubVm.setTab(HubViewModel.Tab.Conversations)
                if (nav.current != Screen.Hub) nav.push(Screen.Hub)
            }
        }
    }
    // Drawer nav (plane/DrawerNav.kt drawerTabRoute → chatHomeNav): Settings
    // stays a real destination (pushed over the session so Back returns to
    // it); Conversations returns to the chat home.
    fun onNavTab(tab: HubTab) {
        when (tab) {
            HubTab.Conversations -> routeChatHome()
            HubTab.Settings -> {
                hubVm.setTab(HubViewModel.Tab.Settings)
                if (nav.current != Screen.Hub) nav.push(Screen.Hub)
            }
        }
    }

    // Drawer Memory → the native wiki hub (its own screen, never a hub tab —
    // plane/DrawerNav.kt drawerOpensMemoryScreen). Like Settings it pushes
    // over the current screen, so system Back returns to the hub or the open
    // session below it; from a topic it pops back to the hub list.
    fun openMemory() {
        when {
            nav.current == Screen.Memory -> Unit
            Screen.Memory in nav.stack -> nav.popTo { it == Screen.Memory }
            else -> nav.push(Screen.Memory)
        }
    }

    val hubSt by hubVm.state.collectAsState()
    val launchNode = hubSt.nodes.find { it.id == hubSt.prefs.viewNodeId }
        ?: hubSt.nodes.find { it.denUrl.trimEnd('/') == hubSt.prefs.entryUrl.trim().trimEnd('/') }
        ?: hubSt.nodes.firstOrNull()
    val launchBaseUrl = launchNode?.denUrl?.trimEnd('/')

    // Launch resolution (2026-09-04 — replaces the session-header launch
    // latch): with no persisted pointer, the Hub Conversations tab is the
    // launch SURFACE (ChatLaunchScreen, the chat-surface loading state); once
    // the multi-node load settles, narrowLaunchTarget resolves pick →
    // new-draft compose. NOT latched: the surface re-resolves whenever it is
    // showing (drawer Conversations and Back-from-Settings land here by
    // design); an open session or the Settings tab never triggers it.
    LaunchedEffect(hubSt.items, hubSt.agents, launchBaseUrl, nav.current, hubSt.tab) {
        if (nav.current != Screen.Hub || hubSt.tab != HubViewModel.Tab.Conversations) {
            return@LaunchedEffect
        }
        val base = launchBaseUrl ?: return@LaunchedEffect
        if (hubSt.nodes.isEmpty()) return@LaunchedEffect
        // Debounce the progressive multi-node load (unchanged): the mesh
        // reports node by node and `loading` never reliably settles, so wait
        // for a quiet window before picking the genuinely most recent session.
        kotlinx.coroutines.delay(LAUNCH_SETTLE_MS)
        if (nav.current != Screen.Hub || hubVm.state.value.tab != HubViewModel.Tab.Conversations) {
            return@LaunchedEffect
        }
        when (
            val target = narrowLaunchTarget(
                // A persisted pointer resumes at nav init, before this runs.
                lastActiveKey = null,
                loaded = true,
                sourceKeys = hubSt.items.map { it.item.key }.toSet(),
                items = hubSt.items.map {
                    LaunchCandidate(
                        it.item.key,
                        it.item.updatedAt,
                        it.item.kind,
                        it.nodeDenUrl.trimEnd('/'),
                        it.item.pin,
                    )
                },
                baseUrl = base,
            )
        ) {
            is NarrowLaunchTarget.Pick -> {
                val row = hubSt.items.firstOrNull { it.item.key == target.key } ?: return@LaunchedEffect
                openRowScreen(row, replaceAll = true)
            }
            NarrowLaunchTarget.New -> {
                // No resumable session anywhere → the new-conversation
                // compose surface (see openNewDraft).
                openNewDraft()
            }
            else -> Unit // Loading/Resume are unreachable here (loaded, no pointer)
        }
    }

    // Stale instant-resume fallback: the persisted last session is gone (its
    // row never arrives once the mesh settles — the session 404'd). Only the
    // session the stack was RESUMED into is checked, and only when its node
    // is online to judge (plane/LaunchSession.kt resumedSessionStale); then
    // forget the pointer and re-resolve through the launch surface.
    LaunchedEffect(hubSt.items, hubSt.nodes, resumedKey, nav.current) {
        val key = resumedKey ?: return@LaunchedEffect
        val cur = nav.current as? Screen.Chat
        if (cur?.sessionKey != key) {
            resumedKey = null // the user moved on (or never resumed) — nothing to police
            return@LaunchedEffect
        }
        if (hubSt.nodes.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(LAUNCH_SETTLE_MS)
        val st = hubVm.state.value
        val nodeOnline = st.nodes.any { it.denUrl.trimEnd('/') == cur.nodeDenUrl.trimEnd('/') && it.online }
        if (resumedSessionStale(key, nodeOnline, st.items.map { it.item.key }.toSet())) {
            resumedKey = null
            c.settings.clearLastSession()
            nav.replaceAll(Screen.Hub) // the launch surface resolves pick/new
        } else if (nodeOnline) {
            // Validated (or unjudgeable no more): stop policing — a later id
            // rotation is the open session's own business, not a stale resume.
            resumedKey = null
        }
    }

    Box(Modifier.fillMaxSize().background(colors.bg).blueprintGrid(colors.gridLine)) {
    when (val s = nav.current) {
        Screen.Enroll -> EnrollScreen(
            c,
            onBack = if (nav.stack.size > 1) ({ nav.pop() }) else null,
            onDone = { nav.replaceAll(Screen.Hub) },
        )
        // Session-header slice: the hub AND a chat session live inside the
        // same left ModalNavigationDrawer (one HubDrawer implementation) —
        // the rail is reachable by ☰ or left-edge swipe from a session too.
        Screen.Hub -> HubDrawer(
            vm = hubVm,
            onOpenChat = { openChatScreen(it) },
            onNavTab = { onNavTab(it) },
            onOpenMemory = { openMemory() },
        ) { openDrawer ->
            HubScreen(
                vm = hubVm,
                c = c,
                onNew = { openNewDraft() },
                onOpenGallery = { nav.push(Screen.Gallery) },
                onForget = {
                    stores.clearAll()
                    hubVm.shutdown()
                    nav.replaceAll(Screen.Enroll)
                },
                onOpenDrawer = openDrawer,
            )
        }
        is Screen.Chat -> {
            CompositionLocalProvider(LocalViewModelStoreOwner provides stores.owner(s.storeKey()!!)) {
                val vm: HarnessChatViewModel = viewModel {
                    HarnessChatViewModel(
                        c, s.sessionKey, s.nodeDenUrl, s.harnessId, s.title, s.draft,
                        presetModel = s.model, presetEffort = s.effort, openStream = openStream,
                        agentId = s.agentId,
                        onAdoptPointer = { from, canonical ->
                            hubVm.adoptChatPointer(s.agentId, from, canonical, s.nodeDenUrl)
                        },
                    )
                }
                // 2026-09-04: the right history drawer's state is lifted here
                // so HubDrawer's unified edge-swipe layer can drive BOTH
                // drawers (both run gesturesEnabled = false; the nested
                // built-in gestures competed and the left swipe lost).
                val historyState = rememberDrawerState(DrawerValue.Closed)
                HubDrawer(
                    vm = hubVm,
                    onOpenChat = { openChatScreen(it) },
                    onNavTab = { onNavTab(it) },
                    rightDrawer = historyState,
                    onOpenMemory = { openMemory() },
                ) { openDrawer ->
                    HistoryDrawer(
                        vm = hubVm,
                        state = historyState,
                        onOpenRow = { openRowScreen(it) },
                        onOpenChat = { openChatScreen(it) },
                    ) { openHistory ->
                        HarnessChatScreen(
                            vm = vm,
                            onOpenDrawer = openDrawer,
                            onOpenHistory = openHistory,
                        )
                    }
                }
            }
        }
        // Memory hub + topic live inside the same left drawer as the hub and a
        // session (☰ / edge swipe everywhere); the topic header shows Back
        // instead of ☰ (session-header vocabulary). System Back pops topic →
        // hub list → whatever is below (hub / session).
        Screen.Memory -> HubDrawer(
            vm = hubVm,
            onOpenChat = { openChatScreen(it) },
            onNavTab = { onNavTab(it) },
            onOpenMemory = { openMemory() },
        ) { openDrawer ->
            MemoryScreen(
                vm = memoryVm,
                nodes = hubSt.nodes,
                onOpenDrawer = openDrawer,
                onOpenTopic = { slug -> nav.push(Screen.MemoryTopic(slug)) },
            )
        }
        is Screen.MemoryTopic -> HubDrawer(
            vm = hubVm,
            onOpenChat = { openChatScreen(it) },
            onNavTab = { onNavTab(it) },
            onOpenMemory = { openMemory() },
        ) {
            MemoryTopicScreen(
                vm = memoryVm,
                slug = s.slug,
                onBack = { nav.pop() },
            )
        }
        Screen.Gallery -> ComponentGallery()
    }
    }
}
