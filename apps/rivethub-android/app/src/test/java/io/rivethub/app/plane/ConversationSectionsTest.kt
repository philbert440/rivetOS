package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessSessionSummary
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationSectionsTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val labels = SectionLabels(
        pinned = "Pinned",
        today = "Today",
        yesterday = "Yesterday",
        dayFormat = DateTimeFormatter.ofPattern("MM-dd", Locale.US),
        dayWithYearFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US),
    )

    private fun ms(y: Int, mo: Int, d: Int, h: Int = 0, mi: Int = 0, s: Int = 0, nanos: Int = 0): Long =
        LocalDateTime.of(y, mo, d, h, mi, s, nanos).atZone(zone).toInstant().toEpochMilli()

    private val now = ms(2026, 9, 25, 10, 0)

    private fun loc(key: String, updatedAt: Long, sessionId: String? = key) = LocatedChatItem(
        ChatItem(key = key, kind = ChatItemKind.HARNESS, title = key, sessionId = sessionId, updatedAt = updatedAt),
        nodeId = "ct115",
        nodeName = "ct115",
        nodeDenUrl = "https://192.0.2.10:5174",
    )

    private fun shape(sections: List<ConversationSection>): List<Pair<String, List<String>>> =
        sections.map { it.label to it.rows.map { r -> r.item.key } }

    @Test fun `pinned rows come first in incoming order and leave their day`() {
        val rows = listOf(
            loc("a", ms(2026, 9, 25, 9)),
            loc("b", ms(2026, 9, 25, 8)),
            loc("c", ms(2026, 9, 24, 8)),
            loc("d", ms(2026, 9, 20, 8)),
        )
        val out = sectionRows(rows, setOf("d", "b"), now, zone, labels)
        assertEquals(
            listOf(
                "Pinned" to listOf("b", "d"),
                "Today" to listOf("a"),
                "Yesterday" to listOf("c"),
            ),
            shape(out),
        )
        assertEquals(SectionKind.Pinned, out[0].kind)
    }

    @Test fun `no pinned section when nothing is pinned and no empty sections`() {
        val out = sectionRows(listOf(loc("a", ms(2026, 9, 23, 12))), setOf("gone"), now, zone, labels)
        assertEquals(listOf("09-23" to listOf("a")), shape(out))
        assertEquals(SectionKind.Day, out[0].kind)
        assertTrue(sectionRows(emptyList(), setOf("a"), now, zone, labels).isEmpty())
    }

    @Test fun `a pin on the canonical session id pins the row`() {
        val row = loc("abc", ms(2026, 9, 25, 9), sessionId = "claude-code:abc")
        val out = sectionRows(listOf(row), setOf("claude-code:abc"), now, zone, labels)
        assertEquals(listOf("Pinned" to listOf("abc")), shape(out))
    }

    @Test fun `today and yesterday split at local midnight`() {
        val rows = listOf(
            loc("t0", ms(2026, 9, 25, 0, 0)),
            loc("y1", ms(2026, 9, 24, 23, 59, 59, 999_000_000)),
            loc("y0", ms(2026, 9, 24, 0, 0)),
            loc("d1", ms(2026, 9, 23, 23, 59, 59)),
        )
        val out = sectionRows(rows, emptySet(), now, zone, labels)
        assertEquals(
            listOf(
                "Today" to listOf("t0"),
                "Yesterday" to listOf("y1", "y0"),
                "09-23" to listOf("d1"),
            ),
            shape(out),
        )
        assertEquals(listOf(SectionKind.Today, SectionKind.Yesterday, SectionKind.Day), out.map { it.kind })
    }

    @Test fun `the local zone decides the day not UTC`() {
        // 2026-09-24 23:30 UTC is already 2026-09-25 01:30 in Berlin.
        val utcLate = java.time.Instant.parse("2026-09-24T23:30:00Z").toEpochMilli()
        val out = sectionRows(listOf(loc("a", utcLate)), emptySet(), now, zone, labels)
        assertEquals(SectionKind.Today, out.single().kind)
    }

    @Test fun `older days are newest first and a previous year carries the year`() {
        val rows = listOf(
            loc("old", ms(2025, 12, 31, 12)),
            loc("sep20", ms(2026, 9, 20, 12)),
            loc("jan1", ms(2026, 1, 1, 12)),
        )
        val out = sectionRows(rows, emptySet(), now, zone, labels)
        assertEquals(
            listOf(
                "09-20" to listOf("sep20"),
                "01-01" to listOf("jan1"),
                "2025-12-31" to listOf("old"),
            ),
            shape(out),
        )
    }

    @Test fun `rows without a usable time or from the future count as today`() {
        val rows = listOf(
            loc("zero", 0L),
            loc("neg", -5L),
            loc("future", ms(2026, 9, 27, 12)),
            loc("y", ms(2026, 9, 24, 12)),
        )
        val out = sectionRows(rows, emptySet(), now, zone, labels)
        assertEquals(
            listOf(
                "Today" to listOf("zero", "neg", "future"),
                "Yesterday" to listOf("y"),
            ),
            shape(out),
        )
    }

    @Test fun `activeIndexIn counts one header per section`() {
        val rows = listOf(
            loc("p", ms(2026, 9, 25, 9)),
            loc("a", ms(2026, 9, 25, 8)),
            loc("b", ms(2026, 9, 25, 7)),
            loc("c", ms(2026, 9, 24, 7)),
        )
        val sections = sectionRows(rows, setOf("p"), now, zone, labels)
        // [Pinned] p [Today] a b [Yesterday] c
        assertEquals(1, activeIndexIn(sections, "p"))
        assertEquals(3, activeIndexIn(sections, "a"))
        assertEquals(4, activeIndexIn(sections, "b"))
        assertEquals(6, activeIndexIn(sections, "c"))
        assertNull(activeIndexIn(sections, "missing"))
        assertNull(activeIndexIn(sections, ""))
        assertNull(activeIndexIn(sections, null))
    }

    @Test fun `activeRowKey resolves a native id to its canonical row`() {
        val rows = listOf(loc("claude-code:abc", ms(2026, 9, 25, 9)), loc("plain", ms(2026, 9, 25, 8)))
        assertEquals("plain", activeRowKey(rows, "plain"))
        assertEquals("claude-code:abc", activeRowKey(rows, "abc"))
        assertNull(activeRowKey(rows, "nope"))
        assertNull(activeRowKey(rows, ""))
    }

    @Test fun `the same rows re-section once the clock passes local midnight`() {
        val rows = listOf(loc("a", ms(2026, 9, 25, 22)), loc("b", ms(2026, 9, 24, 12)))
        val before = ms(2026, 9, 25, 23, 59)
        val after = ms(2026, 9, 26, 0, 1)
        assertEquals(
            listOf("Today" to listOf("a"), "Yesterday" to listOf("b")),
            shape(sectionRows(rows, emptySet(), before, zone, labels)),
        )
        assertEquals(
            listOf("Yesterday" to listOf("a"), "09-24" to listOf("b")),
            shape(sectionRows(rows, emptySet(), after, zone, labels)),
        )
    }

    @Test fun `the day key moves with the local date and the zone`() {
        val morning = ms(2026, 9, 25, 8)
        val evening = ms(2026, 9, 25, 23, 59)
        val pastMidnight = ms(2026, 9, 26, 0, 1)
        assertEquals(dayKeyOf(morning, zone), dayKeyOf(evening, zone))
        assertNotEquals(dayKeyOf(evening, zone), dayKeyOf(pastMidnight, zone))
        // Same instant, another zone: Auckland is already on the 26th.
        val auckland = ZoneId.of("Pacific/Auckland")
        assertEquals(java.time.LocalDate.of(2026, 9, 26), dayKeyOf(evening, auckland).date)
        assertNotEquals(dayKeyOf(evening, zone), dayKeyOf(evening, auckland))
        // Same date, another zone id still re-keys (the zone is part of the key).
        val paris = ZoneId.of("Europe/Paris")
        assertEquals(dayKeyOf(morning, zone).date, dayKeyOf(morning, paris).date)
        assertNotEquals(dayKeyOf(morning, zone), dayKeyOf(morning, paris))
    }

    @Test fun `the sections key changes when any component changes`() {
        val day = java.time.LocalDate.of(2026, 9, 25)
        val base = sectionsKey(openTick = 3, resumeTick = 7, zoneId = "Europe/Berlin", today = day)
        assertEquals(base, sectionsKey(3, 7, "Europe/Berlin", day))
        assertEquals(base.hashCode(), sectionsKey(3, 7, "Europe/Berlin", day).hashCode())
        // Drawer open, foreground resume, zone change, new local day.
        assertNotEquals(base, sectionsKey(4, 7, "Europe/Berlin", day))
        assertNotEquals(base, sectionsKey(3, 8, "Europe/Berlin", day))
        assertNotEquals(base, sectionsKey(3, 7, "Europe/Paris", day))
        assertNotEquals(base, sectionsKey(3, 7, "Europe/Berlin", day.plusDays(1)))
        // The ticks are not interchangeable: open 4 / resume 7 is not open 7 / resume 4.
        assertNotEquals(sectionsKey(4, 7, "Europe/Berlin", day), sectionsKey(7, 4, "Europe/Berlin", day))
    }

    private fun wire(native: String, createdAt: String, updatedAt: String) = HarnessSessionSummary(
        sessionId = "claude-code:$native",
        harnessId = "claude-code",
        createdAt = createdAt,
        updatedAt = updatedAt,
    )

    private fun locateAll(items: List<ChatItem>) = items.map { locate(it, "ct115", "ct115", "https://192.0.2.10:5174") }

    @Test fun `a blank or invalid updatedAt files under a valid createdAt`() {
        val items = chatItems(
            mapOf(
                "claude-code" to Result.success(
                    listOf(
                        wire("blank", createdAt = "2026-09-23T10:00:00Z", updatedAt = ""),
                        wire("junk", createdAt = "2026-09-24T10:00:00+02:00", updatedAt = "not a date"),
                        wire("both", createdAt = "2026-09-20T10:00:00Z", updatedAt = "2026-09-25T08:00:00Z"),
                    ),
                ),
            ),
            emptyList(),
        )
        val out = sectionRows(locateAll(items), emptySet(), now, zone, labels)
        assertEquals(
            listOf(
                "Today" to listOf("claude-code:both"),
                "Yesterday" to listOf("claude-code:junk"),
                "09-23" to listOf("claude-code:blank"),
            ),
            shape(out),
        )
    }

    @Test fun `neither timestamp parsing files the row as today`() {
        val items = chatItems(
            mapOf("claude-code" to Result.success(listOf(wire("x", createdAt = "", updatedAt = "garbage")))),
            emptyList(),
        )
        assertEquals(0L, items.single().updatedAt)
        assertEquals(0L, items.single().createdAt)
        val out = sectionRows(locateAll(items), emptySet(), now, zone, labels)
        assertEquals(listOf("Today" to listOf("claude-code:x")), shape(out))
    }

    @Test fun `activeIndexIn counts the leading line and archived rows after the sections`() {
        val sections = sectionRows(
            listOf(loc("a", ms(2026, 9, 25, 9)), loc("b", ms(2026, 9, 25, 8))),
            emptySet(),
            now,
            zone,
            labels,
        )
        val archived = listOf(loc("x", ms(2026, 9, 1, 9)), loc("y", ms(2026, 8, 1, 9)))
        // [Today] a b | x y
        assertEquals(3, activeIndexIn(sections, "x", archived))
        assertEquals(4, activeIndexIn(sections, "y", archived))
        assertEquals(2, activeIndexIn(sections, "b", archived))
        // Block collapsed: archived rows are not in the list.
        assertNull(activeIndexIn(sections, "y"))
        // Everything archived: [empty line] x y
        assertEquals(1, activeIndexIn(emptyList(), "x", archived, leading = 1))
        assertEquals(2, activeIndexIn(emptyList(), "y", archived, leading = 1))
    }

    @Test fun `activeRowIn finds drafts adopted rows and archived rows`() {
        val uuid = "a1b2c3d4-1111-4222-8333-444455556666"
        val live = listOf(
            loc("claude-code:$uuid", ms(2026, 9, 25, 9)),
            LocatedChatItem(
                ChatItem(key = "d7e8f9a0-4444-4555-8666-777788889999", kind = ChatItemKind.DRAFT, title = "new conversation"),
                nodeId = "ct115",
                nodeName = "ct115",
                nodeDenUrl = "https://192.0.2.10:5174",
            ),
        )
        val archived = listOf(loc("claude-code:arch", ms(2026, 9, 1, 9)), loc("both", ms(2026, 9, 1, 8)))
        // An open draft is highlighted.
        assertEquals(
            ActiveRow("d7e8f9a0-4444-4555-8666-777788889999", archived = false),
            activeRowIn(live, archived, "d7e8f9a0-4444-4555-8666-777788889999"),
        )
        // The chat still holds the draft id after the den adopted it.
        assertEquals(ActiveRow("claude-code:$uuid", archived = false), activeRowIn(live, archived, uuid))
        // Archived, by canonical and by native id.
        assertEquals(ActiveRow("claude-code:arch", archived = true), activeRowIn(live, archived, "claude-code:arch"))
        assertEquals(ActiveRow("claude-code:arch", archived = true), activeRowIn(live, archived, "arch"))
        // Live wins when both lists carry the key.
        assertEquals(ActiveRow("both", archived = false), activeRowIn(live + loc("both", 1L), archived, "both"))
        assertNull(activeRowIn(live, archived, null))
        assertNull(activeRowIn(live, archived, "nope"))
    }
}
