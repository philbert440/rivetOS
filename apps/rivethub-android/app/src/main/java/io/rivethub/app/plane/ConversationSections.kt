package io.rivethub.app.plane

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Conversation list sections (UX-SPEC §2 item 2): Pinned first, then Today,
 * Yesterday, then one section per calendar day, newest first. Labels are
 * resolved by the caller (string resources + a locale-aware formatter) and
 * handed in, so this file stays pure Kotlin.
 */
enum class SectionKind { Pinned, Today, Yesterday, Day }

data class ConversationSection(
    val kind: SectionKind,
    val label: String,
    val rows: List<LocatedChatItem>,
)

data class SectionLabels(
    val pinned: String,
    val today: String,
    val yesterday: String,
    val dayFormat: DateTimeFormatter,
    val dayWithYearFormat: DateTimeFormatter,
)

/** A row is pinned when its key (or its canonical session id) is in [pinned]. */
fun isPinnedItem(item: ChatItem, pinned: Set<String>): Boolean {
    if (item.key in pinned) return true
    val sid = item.sessionId
    return sid != null && sid != item.key && sid in pinned
}

/**
 * The time a row is filed under: `updatedAt`, else `createdAt` (a session
 * whose updatedAt was blank or unparsable), else 0, which files as today.
 */
fun sectionStampOf(item: ChatItem): Long = when {
    item.updatedAt > 0L -> item.updatedAt
    item.createdAt > 0L -> item.createdAt
    else -> 0L
}

/**
 * The calendar day and zone a section list was built for. The pane keys its
 * cached sections on this, so a new day or a zone change rebuilds them.
 */
data class DayKey(val date: LocalDate, val zone: ZoneId)

fun dayKeyOf(nowMs: Long, zone: ZoneId): DayKey =
    DayKey(Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate(), zone)

/**
 * The pane's single cache key for its sections: the drawer-open count, the
 * ON_RESUME count, the zone id and the local date. Any component changing
 * yields an unequal key, so the cached sections are rebuilt on every drawer
 * open, every resume, a zone change and a new local day.
 */
data class SectionsKey(val openTick: Int, val resumeTick: Int, val zoneId: String, val today: LocalDate)

fun sectionsKey(openTick: Int, resumeTick: Int, zoneId: String, today: LocalDate): Any =
    SectionsKey(openTick, resumeTick, zoneId, today)

/**
 * Group [rows] (already recency-ordered) into sections. Pinned rows are pulled
 * out first, in their incoming order. Every other row lands on the local
 * calendar day of its [sectionStampOf] time in [zone]; a row without a usable
 * timestamp or one stamped in the future counts as today. Days come
 * newest first, a day in an earlier year than [nowMs] uses the year format,
 * and no section is ever empty.
 */
fun sectionRows(
    rows: List<LocatedChatItem>,
    pinned: Set<String>,
    nowMs: Long,
    zone: ZoneId,
    labels: SectionLabels,
): List<ConversationSection> {
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val yesterday = today.minusDays(1)
    val pinnedRows = ArrayList<LocatedChatItem>()
    val byDay = LinkedHashMap<LocalDate, ArrayList<LocatedChatItem>>()
    for (row in rows) {
        if (isPinnedItem(row.item, pinned)) {
            pinnedRows += row
            continue
        }
        val ms = sectionStampOf(row.item)
        val day = if (ms <= 0L) today else {
            val d = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
            if (d.isAfter(today)) today else d
        }
        byDay.getOrPut(day) { ArrayList() } += row
    }
    val out = ArrayList<ConversationSection>()
    if (pinnedRows.isNotEmpty()) out += ConversationSection(SectionKind.Pinned, labels.pinned, pinnedRows)
    for (day in byDay.keys.sortedDescending()) {
        val dayRows = byDay.getValue(day)
        out += when (day) {
            today -> ConversationSection(SectionKind.Today, labels.today, dayRows)
            yesterday -> ConversationSection(SectionKind.Yesterday, labels.yesterday, dayRows)
            else -> ConversationSection(
                SectionKind.Day,
                if (day.year == today.year) labels.dayFormat.format(day) else labels.dayWithYearFormat.format(day),
                dayRows,
            )
        }
    }
    return out
}

/**
 * Flat lazy-list index of the row keyed [activeKey]. [leading] items sit
 * before the first section (the pane's empty-state line). Each section counts
 * one header item before its rows. [archived] rows follow the last section
 * with no header; pass them only while the archived block is expanded. Null
 * when the key is blank or not listed.
 */
fun activeIndexIn(
    sections: List<ConversationSection>,
    activeKey: String?,
    archived: List<LocatedChatItem> = emptyList(),
    leading: Int = 0,
): Int? {
    if (activeKey.isNullOrBlank()) return null
    var index = leading
    for (section in sections) {
        index += 1
        for (row in section.rows) {
            if (row.item.key == activeKey) return index
            index += 1
        }
    }
    for (row in archived) {
        if (row.item.key == activeKey) return index
        index += 1
    }
    return null
}

/**
 * Which listed row is the open conversation: exact key first, then the same
 * den room (native vs canonical id, so a draft still matches after the den
 * adopts it).
 */
fun activeRowKey(rows: List<LocatedChatItem>, openKey: String?): String? {
    if (openKey.isNullOrBlank()) return null
    return findChatItem(rows.map { it.item }, openKey)?.key
}

/** The open conversation's row, and whether it sits in the archived block. */
data class ActiveRow(val key: String, val archived: Boolean)

/** Live rows win over archived ones; null when the open session is not listed. */
fun activeRowIn(
    live: List<LocatedChatItem>,
    archived: List<LocatedChatItem>,
    openKey: String?,
): ActiveRow? {
    activeRowKey(live, openKey)?.let { return ActiveRow(it, archived = false) }
    activeRowKey(archived, openKey)?.let { return ActiveRow(it, archived = true) }
    return null
}
