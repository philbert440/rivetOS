package io.rivethub.app.plane

import io.rivethub.app.gateway.WikiIndexEntry
import io.rivethub.app.gateway.WikiPageResponse
import io.rivethub.app.transport.NodeRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoryWikiTest {
    private val now = java.time.Instant.parse("2026-09-04T12:00:00Z").toEpochMilli()

    private fun entry(slug: String, title: String = slug, updatedAt: String = "", excerpt: String = "") =
        WikiIndexEntry(slug = slug, title = title, updatedAt = updatedAt, excerpt = excerpt)

    @Test
    fun `memory tabs are search wiki browse stats in nav order`() {
        assertEquals(
            listOf(MemoryTab.Search, MemoryTab.Wiki, MemoryTab.Browse, MemoryTab.Stats),
            memoryTabs(),
        )
    }

    @Test
    fun `topic row falls back to the slug for blank title and excerpt`() {
        val row = topicRowModel(entry("mesh-nodes", title = "", excerpt = ""), now)
        assertEquals("mesh-nodes", row.title)
        assertEquals("mesh-nodes", row.excerpt)
        assertEquals("mesh-nodes", row.slug)
    }

    @Test
    fun `staleness buckets mirror the web labels`() {
        assertEquals(StalenessKind.Fresh, stalenessLabel("2026-09-04T00:00:00Z", now).kind)
        assertEquals("current", stalenessLabel("2026-09-01T00:00:00Z", now).label)
        val aging = stalenessLabel("2026-08-20T00:00:00Z", now)
        assertEquals(StalenessKind.Aging, aging.kind)
        assertEquals("15d", aging.label)
        val stale = stalenessLabel("2026-07-01T00:00:00Z", now)
        assertEquals(StalenessKind.Stale, stale.kind)
        assertEquals("65d stale", stale.label)
        assertEquals(StalenessKind.Never, stalenessLabel(null, now).kind)
        assertEquals(StalenessKind.Never, stalenessLabel("not a date", now).kind)
        assertEquals("never verified", stalenessLabel("", now).label)
    }

    @Test
    fun `wiki rows sort alphabetically and browse rows newest first`() {
        val topics = listOf(
            entry("b", title = "Beta", updatedAt = "2026-09-01T00:00:00Z"),
            entry("a", title = "Alpha", updatedAt = "2026-09-03T00:00:00Z"),
            entry("c", title = "gamma", updatedAt = "2026-08-30T00:00:00Z"),
        )
        assertEquals(listOf("a", "b", "c"), wikiRows(topics, now).map { it.slug })
        assertEquals(listOf("a", "b", "c"), browseRows(topics, now).map { it.slug })
        // descending by updatedAt regardless of input order
        val shuffled = listOf(
            entry("x", updatedAt = "2026-01-01T00:00:00Z"),
            entry("y", updatedAt = "2026-03-01T00:00:00Z"),
            entry("z", updatedAt = "2026-02-01T00:00:00Z"),
        )
        assertEquals(listOf("y", "z", "x"), browseRows(shuffled, now).map { it.slug })
    }

    @Test
    fun `stats count staleness buckets and rank longest unverified first`() {
        val topics = listOf(
            entry("fresh", updatedAt = "2026-09-04T00:00:00Z"),
            entry("aging", updatedAt = "2026-08-20T00:00:00Z"),
            entry("stale", updatedAt = "2026-07-01T00:00:00Z"),
            entry("never"),
            entry("oldest", updatedAt = "2026-01-01T00:00:00Z"),
        )
        val stats = memoryStats(topics, total = 42, nowMs = now)
        assertEquals(42, stats.total)
        assertEquals(1, stats.fresh)
        assertEquals(1, stats.aging)
        assertEquals(2, stats.stale)
        assertEquals(1, stats.never)
        assertEquals(listOf("never", "oldest", "stale"), stats.stalest.take(3).map { it.slug })
        // total falls back to the list size when the server total is absent
        assertEquals(5, memoryStats(topics, total = 0, nowMs = now).total)
    }

    @Test
    fun `toc keeps level two and three headings and slugifies ids`() {
        val md = """
            # Title (not in TOC)
            ## Current state
            Body **text** with `code`.
            ### Sub section!
            #### too deep
            ## Second Heading ##
            ``` 
            ## inside a fence
            ```
        """.trimIndent()
        val toc = tocFromMarkdown(md)
        assertEquals(
            listOf(
                TocEntry(2, "Current state", "current-state"),
                TocEntry(3, "Sub section!", "sub-section"),
                TocEntry(2, "Second Heading", "second-heading"),
            ),
            toc,
        )
    }

    @Test
    fun `headingId mirrors the web slug rule`() {
        assertEquals("hello-world", headingId("Hello World"))
        assertEquals("rivetos-memory-v6", headingId("RivetOS memory (v6)"))
        assertEquals("a-b", headingId("a — b"))
        assertTrue(headingId("x".repeat(200)).length <= 80)
    }

    @Test
    fun `wiki body prefers currentState and falls back to the full file`() {
        val page = WikiPageResponse(slug = "s", currentState = "Lead.", markdown = "Full file.")
        assertEquals("Lead.", wikiBody(page))
        val blank = WikiPageResponse(slug = "s", currentState = "  ", markdown = "Full file.")
        assertEquals("Full file.", wikiBody(blank))
    }

    @Test
    fun `wiki links convert to in-app memory links`() {
        assertEquals(
            "see [mesh-nodes](/memory/mesh-nodes) and [a](/memory/a)",
            wikiLinksToMarkdown("see [[mesh-nodes]] and [[a]]"),
        )
        // not a slug shape — left alone
        assertEquals("[[Not A Slug]]", wikiLinksToMarkdown("[[Not A Slug]]"))
    }

    @Test
    fun `wiki date label trims to the date part`() {
        assertEquals("2026-09-04", wikiDateLabel("2026-09-04T10:11:12Z"))
        assertEquals("—", wikiDateLabel(null))
        assertEquals("—", wikiDateLabel(""))
    }

    @Test
    fun `datahub node matches by id or name and tolerates absence`() {
        val pve = NodeRef(id = "pve3", name = "pve3", denUrl = "https://pve3.example:5174", online = true)
        val hub = NodeRef(id = "datahub", name = "hub", denUrl = "https://hub.example:5174", online = true)
        val named = NodeRef(id = "n1", name = "datahub-west", denUrl = "https://w.example:5174", online = true)
        assertEquals(hub, datahubNode(listOf(pve, hub)))
        assertEquals(named, datahubNode(listOf(pve, named)))
        assertNull(datahubNode(listOf(pve)))
        assertNull(datahubNode(emptyList()))
    }

    @Test
    fun `searching only on a non-blank query`() {
        assertFalse(memorySearching(""))
        assertFalse(memorySearching("   "))
        assertTrue(memorySearching("mesh"))
    }
}
