package io.rivethub.app.plane

/**
 * D2 hub chrome rules, mirrored from rivethub-web. Pure so the JVM tests can
 * pin them; the composables stay dumb.
 */

/** What the mobile top bar shows after the ☰ + DenBot (web `hubPageTitle`, sidebar-chrome.ts). */
enum class TopBarTitle { Wordmark, Settings }

/**
 * Web rule (lib/session-header.ts `showMobileTopBar`): the wordmark bar shows
 * on every narrow screen EXCEPT an open session. A session renders no TopBar
 * at all — the one-row session header owns the top inset there (chat.tsx:1645)
 * — so this rule only has hub-tab inputs: wordmark on Conversations, page
 * title on Settings. There is deliberately no session (null) case anymore.
 */
fun topBarTitle(tab: HubTab): TopBarTitle = when (tab) {
    HubTab.Settings -> TopBarTitle.Settings
    HubTab.Conversations -> TopBarTitle.Wordmark
}

/**
 * Mobile drawer width — sidebar.tsx:189 fixes the phone sheet at `w-64`
 * (256dp), never wider than 85% of a narrow screen.
 */
fun drawerWidthDp(maxWidthDp: Float): Float = minOf(256f, maxWidthDp * 0.85f)

/**
 * Conversation pane rows — chat.tsx:833 maps the recency list 1:1 into rows.
 * There are no node or agent group headers (D2-3): node selection lives in
 * the drawer footer node switcher, agent selection in the drawer Agents
 * section. This mapping is named so the rule stays greppable and tested.
 */
fun paneRows(items: List<LocatedChatItem>): List<LocatedChatItem> = items

/** The mono `discovering… n/m` line renders only while node bundles are pending. */
fun discoveringLineVisible(done: Int, total: Int): Boolean = total > 0 && done < total
