package io.rivethub.app.plane

/** Destinations in the left rail. Phase-2 rows render but do not navigate; Memory routes to its own screen. */
enum class DrawerDest {
    Conversations,
    Memory,
    Files,
    Tasks,
    Workflows,
    Settings,
}

enum class HubTab { Conversations, Settings }

/** Unfinished drawer sections. Memory is a real destination (native wiki hub) — not experimental. */
data class ExperimentalFlags(
    val files: Boolean = false,
    val tasks: Boolean = false,
    val workflows: Boolean = false,
)

fun drawerDestVisible(dest: DrawerDest, exp: ExperimentalFlags = ExperimentalFlags()): Boolean = when (dest) {
    DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Settings -> true
    DrawerDest.Files -> exp.files
    DrawerDest.Tasks -> exp.tasks
    DrawerDest.Workflows -> exp.workflows
}

fun drawerDestEnabled(dest: DrawerDest, exp: ExperimentalFlags = ExperimentalFlags()): Boolean = when (dest) {
    DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Settings -> true
    DrawerDest.Files -> exp.files
    DrawerDest.Tasks -> exp.tasks
    DrawerDest.Workflows -> exp.workflows
}

fun drawerPrimaryNav(): List<DrawerDest> =
    listOf(DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Files)

fun drawerSecondaryNav(): List<DrawerDest> =
    listOf(DrawerDest.Tasks, DrawerDest.Workflows)

fun drawerVisiblePrimary(exp: ExperimentalFlags): List<DrawerDest> =
    drawerPrimaryNav().filter { drawerDestVisible(it, exp) }

fun drawerVisibleSecondary(exp: ExperimentalFlags): List<DrawerDest> =
    drawerSecondaryNav().filter { drawerDestVisible(it, exp) }

/** DataStore missing keys read as off — same default as Prefs.exp*. */
fun storedExperimentalFlags(files: Boolean?, tasks: Boolean?, workflows: Boolean?) = ExperimentalFlags(
    files = files ?: false,
    tasks = tasks ?: false,
    workflows = workflows ?: false,
)

fun drawerItemActive(dest: DrawerDest, tab: HubTab): Boolean = when (dest) {
    DrawerDest.Conversations -> tab == HubTab.Conversations
    DrawerDest.Settings -> tab == HubTab.Settings
    else -> false
}

fun hubTabOf(dest: DrawerDest): HubTab? = when (dest) {
    DrawerDest.Conversations -> HubTab.Conversations
    DrawerDest.Settings -> HubTab.Settings
    else -> null
}

/**
 * Drawer nav resolves to the same hub tab from EVERY origin — the hub itself
 * or an open session (session-header slice: the session screen lives inside
 * the same left drawer; from a session the UI additionally pops back to the
 * hub, but the tab rule is identical). Phase-2 rows stay inert (null) from
 * every origin. MainActivity routes both origins through this one function.
 */
fun drawerTabRoute(dest: DrawerDest): HubTab? = hubTabOf(dest)

/**
 * Memory is its own SCREEN (the native wiki hub, Screen.Memory), never a hub
 * tab — the drawer routes it separately from drawerTabRoute, exactly like the
 * web where /memory is a route, not a chat tab.
 */
fun drawerOpensMemoryScreen(dest: DrawerDest): Boolean = dest == DrawerDest.Memory

/**
 * Left-nav Conversations → the CHAT HOME, never a list screen (Phil
 * 2026-09-04: the list is not an app screen; it lives only in the right
 * history drawer). The home is the ACTIVE session when one is on the back
 * stack — popping to it beats resolving a pick — and only a stack without
 * any session needs the pick/new resolution.
 */
enum class ChatHomeNav { AlreadyHome, PopToSession, Resolve }

fun chatHomeNav(currentIsChat: Boolean, stackHasChat: Boolean): ChatHomeNav = when {
    currentIsChat -> ChatHomeNav.AlreadyHome
    stackHasChat -> ChatHomeNav.PopToSession
    else -> ChatHomeNav.Resolve
}

/**
 * System Back on the Settings tab returns to Conversations.
 * Conversations yields null so the activity can finish as normal.
 */
fun hubTabOnBack(tab: HubTab): HubTab? = when (tab) {
    HubTab.Settings -> HubTab.Conversations
    HubTab.Conversations -> null
}

/** Desktop unread pill: blank when 0, capped at `99+`. */
fun formatUnreadBadge(unread: Int): String? = when {
    unread <= 0 -> null
    unread > 99 -> "99+"
    else -> unread.toString()
}
