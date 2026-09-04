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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import io.rivethub.app.plane.ChatItemKind
import io.rivethub.app.plane.HubTab
import io.rivethub.app.plane.LaunchCandidate
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.displayTitle
import io.rivethub.app.plane.findChatItem
import io.rivethub.app.plane.isDraftSessionId
import io.rivethub.app.plane.pickLaunchSession
import io.rivethub.app.ui.HarnessChatViewModel
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.Nav
import io.rivethub.app.ui.Screen
import io.rivethub.app.ui.components.ComponentGallery
import io.rivethub.app.ui.screens.EnrollScreen
import io.rivethub.app.ui.screens.HarnessChatScreen
import io.rivethub.app.ui.screens.HistoryDrawer
import io.rivethub.app.ui.screens.HubDrawer
import io.rivethub.app.ui.screens.HubScreen
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
    val nav = remember {
        Nav(if (c.identity.hasIdentity() && p.entryUrl.isNotBlank() && p.onboarded) Screen.Hub else Screen.Enroll)
    }
    val stores: ScreenStores = viewModel(key = "screen-stores")
    val hubVm: HubViewModel = viewModel(key = "hub") { HubViewModel(c) }
    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }
    val liveKeys = nav.stack.mapNotNull { it.storeKey() }.toSet()
    LaunchedEffect(liveKeys) { stores.retainOnly(liveKeys) }

    val newTitle = stringResource(R.string.new_conversation)

    // Opening a chat from the hub PUSHES; from inside a session (the right
    // history drawer, or a drawer agent row) it REPLACES the open session —
    // web row tap switches the active session in place (chat.tsx:585-626) —
    // so system Back from a session always lands on the hub list.
    fun openChat(chat: Screen.Chat) {
        if (nav.current is Screen.Chat) nav.pop()
        nav.push(chat)
    }
    fun openChatScreen(open: AgentOpen) {
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
        )
    }
    fun openRowScreen(row: LocatedChatItem) {
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
        )
    }
    // Drawer nav routes identically from the hub and from a session
    // (plane/DrawerNav.kt drawerTabRoute): apply the tab, then make sure the
    // hub is showing (pops an open session; a no-op on the hub itself).
    fun routeToTab(tab: HubTab) {
        hubVm.setTab(
            when (tab) {
                HubTab.Conversations -> HubViewModel.Tab.Conversations
                HubTab.Settings -> HubViewModel.Tab.Settings
            },
        )
        nav.popTo { it == Screen.Hub }
    }

    // Chat-first launch (web lib/launch-session.ts + chat.tsx:463-475): the
    // hub auto-opens the most recent session for the current node — an
    // in-progress draft wins. Latched: once any session has been established,
    // an explicit return to the list must not bounce back into a thread.
    val hubSt by hubVm.state.collectAsState()
    var launchLatched by remember { mutableStateOf(false) }
    val launchNode = hubSt.nodes.find { it.id == hubSt.prefs.viewNodeId }
        ?: hubSt.nodes.find { it.denUrl.trimEnd('/') == hubSt.prefs.entryUrl.trim().trimEnd('/') }
        ?: hubSt.nodes.firstOrNull()
    val launchBaseUrl = launchNode?.denUrl?.trimEnd('/')
    LaunchedEffect(hubSt.items, hubSt.agents, launchBaseUrl, launchLatched, nav.current) {
        if (launchLatched) return@LaunchedEffect
        when (nav.current) {
            // A session was already established (user action or this pick).
            is Screen.Chat -> {
                launchLatched = true
                return@LaunchedEffect
            }
            Screen.Hub -> Unit
            // Enroll / Gallery: not the hub — wait for the hub to show.
            else -> return@LaunchedEffect
        }
        val base = launchBaseUrl ?: return@LaunchedEffect
        if (hubSt.nodes.isEmpty()) return@LaunchedEffect
        // Debounce the progressive multi-node load: the mesh reports node by
        // node, and `loading` never reliably settles (refreshes coalesce and
        // re-run), so we can't wait on it. Instead we wait for a quiet window
        // — no new items/agents for LAUNCH_SETTLE_MS — which means the visible
        // set is stable enough to pick the genuinely most recent session. Any
        // change to items/agents restarts this effect (and the delay).
        kotlinx.coroutines.delay(LAUNCH_SETTLE_MS)
        launchLatched = true
        val pick = pickLaunchSession(
            hubSt.items.map {
                LaunchCandidate(
                    it.item.key,
                    it.item.updatedAt,
                    it.item.kind,
                    it.nodeDenUrl.trimEnd('/'),
                    it.item.pin,
                )
            },
            base,
        )
        if (pick != null) {
            val row = hubSt.items.firstOrNull { it.item.key == pick } ?: return@LaunchedEffect
            openRowScreen(row)
            return@LaunchedEffect
        }
        // No resumable session anywhere → open the current agent's thread
        // (never the list). Tap, not Plus: Tap resumes the agent's pinned
        // draft if one exists (a pinned draft is excluded from the pick above,
        // so Plus would mint a duplicate) and otherwise mints one. Needs a
        // current agent; if none can be chosen, the list stays so the user can
        // pick one.
        when (val act = newConversationAction(hubSt.prefs.currentAgentId, hubSt.agents.map { it.agentId })) {
            is NewConversationAction.ForAgent -> {
                val agent = hubSt.agents.find { it.agentId == act.agentId } ?: return@LaunchedEffect
                openChatScreen(hubVm.openAgentAction(agent, AgentAction.Tap))
            }
            NewConversationAction.PickAgent -> Unit
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
            onNavTab = { routeToTab(it) },
        ) { openDrawer ->
            HubScreen(
                vm = hubVm,
                c = c,
                onOpenChat = { openChatScreen(it) },
                onOpenRow = { openRowScreen(it) },
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
                HubDrawer(
                    vm = hubVm,
                    onOpenChat = { openChatScreen(it) },
                    onNavTab = { routeToTab(it) },
                ) { openDrawer ->
                    HistoryDrawer(
                        vm = hubVm,
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
        Screen.Gallery -> ComponentGallery()
    }
    }
}
