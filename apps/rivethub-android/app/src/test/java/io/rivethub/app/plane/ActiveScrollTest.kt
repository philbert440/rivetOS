package io.rivethub.app.plane

import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveScrollTest {
    private val zone = ZoneId.of("Europe/Berlin")
    private val labels = SectionLabels(
        pinned = "Pinned",
        today = "Today",
        yesterday = "Yesterday",
        dayFormat = DateTimeFormatter.ofPattern("MM-dd", Locale.US),
        dayWithYearFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US),
    )

    private fun ms(d: Int, h: Int): Long =
        LocalDateTime.of(2026, 9, d, h, 0).atZone(zone).toInstant().toEpochMilli()

    private val now = ms(25, 10)

    private fun loc(key: String, updatedAt: Long) = LocatedChatItem(
        ChatItem(key = key, kind = ChatItemKind.HARNESS, title = key, sessionId = key, updatedAt = updatedAt),
        nodeId = "ct115",
        nodeName = "ct115",
        nodeDenUrl = "https://192.0.2.10:5174",
    )

    // [Pinned] p [Today] a b [Yesterday] c
    private val sections = sectionRows(
        listOf(loc("p", ms(25, 9)), loc("a", ms(25, 8)), loc("b", ms(25, 7)), loc("c", ms(24, 7))),
        setOf("p"),
        now,
        zone,
        labels,
    )

    @Test fun `the drawer list model keeps a header item in front of every section`() {
        // The integrator's screenshot showed no "Today"; the model does carry it.
        assertEquals(listOf("Pinned", "Today", "Yesterday"), sections.map { it.label })
        assertEquals(ActiveScrollTarget(row = 3, header = 2), activeScrollTarget(sections, "a"))
    }

    @Test fun `the open row targets its own section header`() {
        assertEquals(ActiveScrollTarget(row = 1, header = 0), activeScrollTarget(sections, "p"))
        assertEquals(ActiveScrollTarget(row = 4, header = 2), activeScrollTarget(sections, "b"))
        assertEquals(ActiveScrollTarget(row = 6, header = 5), activeScrollTarget(sections, "c"))
        // Row indices agree with activeIndexIn (the list layout both count).
        for (key in listOf("p", "a", "b", "c")) {
            assertEquals(activeIndexIn(sections, key), activeScrollTarget(sections, key)?.row)
        }
    }

    @Test fun `leading line shifts both indices and archived rows have no header`() {
        assertEquals(ActiveScrollTarget(row = 4, header = 3), activeScrollTarget(sections, "a", leading = 1))
        val archived = listOf(loc("x", ms(1, 9)))
        assertEquals(ActiveScrollTarget(row = 7, header = null), activeScrollTarget(sections, "x", archived))
        assertNull(activeScrollTarget(sections, "x"))
        assertNull(activeScrollTarget(sections, null))
        assertNull(activeScrollTarget(sections, ""))
    }

    @Test fun `item visibility needs the whole item inside the viewport`() {
        val spans = listOf(VisibleSpan(2, 0, 40), VisibleSpan(3, 40, 80), VisibleSpan(4, 120, 80))
        assertTrue(itemFullyVisible(3, spans, 0, 200))
        assertTrue(itemFullyVisible(4, spans, 0, 200))
        assertFalse(itemFullyVisible(4, spans, 0, 150))
        assertFalse(itemFullyVisible(2, spans, 10, 200))
        assertFalse(itemFullyVisible(9, spans, 0, 200))
    }
}
