package io.rivethub.app.plane

/**
 * D2 hub chrome rules, mirrored from rivethub-web. Pure so the JVM tests can
 * pin them; the composables stay dumb.
 */

/** What the mobile top bar shows after the DenBot (web `hubPageTitle`, sidebar-chrome.ts). */
enum class TopBarTitle { Wordmark, Settings }

/**
 * Web rule: the home page (`/`) and every session show the `RivetHub`
 * wordmark; named pages show their page title. Session / enroll screens have
 * no hub tab and pass null — the bar keeps the wordmark above the back row.
 */
fun topBarTitle(tab: HubTab?): TopBarTitle = when (tab) {
    HubTab.Settings -> TopBarTitle.Settings
    HubTab.Conversations, null -> TopBarTitle.Wordmark
}

/**
 * Mobile drawer width — sidebar.tsx:189 fixes the phone sheet at `w-64`
 * (256dp); under 360dp the sheet takes 85% of the screen (D1a rule).
 */
fun drawerWidthDp(maxWidthDp: Float): Float =
    if (maxWidthDp < 360f) maxWidthDp * 0.85f else 256f

/**
 * Conversation pane rows — chat.tsx:833 maps the recency list 1:1 into rows.
 * There are no node or agent group headers (D2-3): node selection lives in
 * the drawer footer node switcher, agent selection in the drawer Agents
 * section. This mapping is named so the rule stays greppable and tested.
 */
fun paneRows(items: List<LocatedChatItem>): List<LocatedChatItem> = items

/** The mono `discovering… n/m` line renders only while node bundles are pending. */
fun discoveringLineVisible(done: Int, total: Int): Boolean = total > 0 && done < total
