package io.rivethub.app.plane

/** Destinations in the left rail. Phase-2 rows render but do not navigate. */
enum class DrawerDest {
    Conversations,
    Memory,
    Files,
    Tasks,
    Workflows,
    Settings,
}

enum class HubTab { Conversations, Settings }

fun drawerDestEnabled(dest: DrawerDest): Boolean = when (dest) {
    DrawerDest.Conversations, DrawerDest.Settings -> true
    DrawerDest.Memory, DrawerDest.Files, DrawerDest.Tasks, DrawerDest.Workflows -> false
}

fun drawerPrimaryNav(): List<DrawerDest> =
    listOf(DrawerDest.Conversations, DrawerDest.Memory, DrawerDest.Files)

fun drawerSecondaryNav(): List<DrawerDest> =
    listOf(DrawerDest.Tasks, DrawerDest.Workflows)

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
