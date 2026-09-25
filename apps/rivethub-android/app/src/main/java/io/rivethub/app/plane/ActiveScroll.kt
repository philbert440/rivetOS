package io.rivethub.app.plane

/**
 * Where the drawer's conversation list scrolls on open (drawer v2 fix1).
 * Scrolling straight to the open conversation's row pinned it to the top of
 * the viewport and pushed its section header ("Today", "Pinned", …) off the
 * top, so the list read as unsectioned. The pane now scrolls to the row's
 * section header first and only falls back to the row itself when the row
 * would not then be fully on screen (a row deep inside a long section).
 *
 * Item indices follow the pane's LazyColumn layout, the same one
 * [activeIndexIn] counts: [leading] items (the empty-state line), then per
 * section one header item followed by its rows, then the archived rows (no
 * header of their own).
 */
data class ActiveScrollTarget(
    /** Index of the open conversation's row. */
    val row: Int,
    /** Index of that row's section header; null for an archived row. */
    val header: Int?,
)

fun activeScrollTarget(
    sections: List<ConversationSection>,
    activeKey: String?,
    archived: List<LocatedChatItem> = emptyList(),
    leading: Int = 0,
): ActiveScrollTarget? {
    if (activeKey.isNullOrBlank()) return null
    var index = leading
    for (section in sections) {
        val header = index
        index += 1
        for (row in section.rows) {
            if (row.item.key == activeKey) return ActiveScrollTarget(row = index, header = header)
            index += 1
        }
    }
    for (row in archived) {
        if (row.item.key == activeKey) return ActiveScrollTarget(row = index, header = null)
        index += 1
    }
    return null
}

/** One laid-out list item: its index, top offset and height, in px. */
data class VisibleSpan(val index: Int, val offset: Int, val size: Int)

/**
 * True when item [index] is laid out entirely inside the viewport
 * `[viewportStart, viewportEnd]` (the list's own layout info, px).
 */
fun itemFullyVisible(index: Int, spans: List<VisibleSpan>, viewportStart: Int, viewportEnd: Int): Boolean {
    val span = spans.firstOrNull { it.index == index } ?: return false
    return span.offset >= viewportStart && span.offset + span.size <= viewportEnd
}
