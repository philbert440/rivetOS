package io.rivethub.app.plane

import io.rivethub.app.gateway.WikiIndexEntry
import io.rivethub.app.gateway.WikiPageResponse
import io.rivethub.app.transport.NodeRef

/**
 * Presentational model for the native Memory hub / topic chrome — the Kotlin
 * mirror of rivethub-web `src/lib/memory-hub.ts` (+ the wiki helpers in
 * `src/lib/wiki-base.ts`). The wiki lives on datahub and is read over
 * `GET /api/wiki` (gateway/Wire.kt shapes); these helpers turn the wire data
 * into rows/tabs/TOC so the layout rules can fail a unit test on revert.
 */

/** Hub tabs — order is the MemoryHubNav contract (web MemoryHubNav.tsx TABS). */
enum class MemoryTab { Search, Wiki, Browse, Stats }

fun memoryTabs(): List<MemoryTab> =
    listOf(MemoryTab.Search, MemoryTab.Wiki, MemoryTab.Browse, MemoryTab.Stats)

// -- staleness (web wiki-base.ts stalenessLabel) ------------------------------

enum class StalenessKind { Fresh, Aging, Stale, Never }

data class Staleness(val kind: StalenessKind, val label: String)

private const val DAY_MS = 86_400_000L

/** `updatedAt` is an ISO timestamp; unparseable/missing reads as never-verified. */
fun stalenessLabel(updatedAt: String?, nowMs: Long): Staleness {
    val parsed = updatedAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
        ?: return Staleness(StalenessKind.Never, "never verified")
    val days = ((nowMs - parsed) / DAY_MS).toInt()
    return when {
        days > 30 -> Staleness(StalenessKind.Stale, "${days}d stale")
        days > 7 -> Staleness(StalenessKind.Aging, "${days}d")
        else -> Staleness(StalenessKind.Fresh, "current")
    }
}

// -- topic rows (web memory-hub.ts topicRowModel) -----------------------------

data class WikiTopicRow(
    val title: String,
    val slug: String,
    val excerpt: String,
    val staleness: Staleness,
)

/** Title + staleness for a tappable hub row → the topic screen. */
fun topicRowModel(t: WikiIndexEntry, nowMs: Long): WikiTopicRow = WikiTopicRow(
    title = t.title.ifBlank { t.slug },
    slug = t.slug,
    excerpt = t.excerpt.ifBlank { t.slug },
    staleness = stalenessLabel(t.updatedAt, nowMs),
)

/** Wiki tab — alphabetical index (web AllTopics). */
fun wikiRows(topics: List<WikiIndexEntry>, nowMs: Long): List<WikiTopicRow> =
    topics.sortedBy { it.title.lowercase() }.map { topicRowModel(it, nowMs) }

/** Browse tab — recent changes, newest first (web RecentTopics). */
fun browseRows(topics: List<WikiIndexEntry>, nowMs: Long): List<WikiTopicRow> =
    topics.sortedByDescending { it.updatedAt }.map { topicRowModel(it, nowMs) }

// -- stats tab (client-side over the index; the web Stats tab hits /api/memory) --

data class MemoryStatsModel(
    val total: Int,
    val fresh: Int,
    val aging: Int,
    val stale: Int,
    val never: Int,
    /** Longest-unverified topics, oldest first (web gaps "stalest"). */
    val stalest: List<WikiTopicRow>,
)

fun memoryStats(topics: List<WikiIndexEntry>, total: Int, nowMs: Long, stalestLimit: Int = 5): MemoryStatsModel {
    val rows = topics.map { topicRowModel(it, nowMs) }
    return MemoryStatsModel(
        total = if (total > 0) total else topics.size,
        fresh = rows.count { it.staleness.kind == StalenessKind.Fresh },
        aging = rows.count { it.staleness.kind == StalenessKind.Aging },
        stale = rows.count { it.staleness.kind == StalenessKind.Stale },
        never = rows.count { it.staleness.kind == StalenessKind.Never },
        // Longest unverified: never-verified (blank) first, then oldest date.
        stalest = topics
            .sortedWith(compareBy({ it.updatedAt.isNotBlank() }, { it.updatedAt }))
            .take(stalestLimit)
            .map { topicRowModel(it, nowMs) },
    )
}

// -- table of contents (web wiki-base.ts tocFromMarkdown / headingId) ---------

data class TocEntry(val level: Int, val text: String, val id: String)

/** Stable heading id for TOC anchors. Mirrors wiki-base.ts headingId. */
fun headingId(text: String): String = text
    .lowercase()
    .trim()
    .replace(Regex("[^\\w\\s-]"), "")
    .replace(Regex("\\s+"), "-")
    .replace(Regex("-+"), "-")
    .take(80)

private fun inlineText(inlines: List<MdInline>): String = inlines.joinToString("") {
    when (it) {
        is MdInline.Text -> it.text
        is MdInline.Code -> it.text
        is MdInline.Link -> it.text
        is MdInline.Bold -> it.text
        is MdInline.Italic -> it.text
    }
}

/** ## / ### headings → Contents entries, from the already-parsed blocks. */
fun tocFromBlocks(blocks: List<MdBlock>): List<TocEntry> = blocks.mapNotNull { block ->
    if (block !is MdBlock.Heading || block.level !in 2..3) return@mapNotNull null
    val text = inlineText(block.inlines).replace(Regex("#+\\s*$"), "").trim()
    if (text.isEmpty()) null else TocEntry(block.level, text, headingId(text))
}

fun tocFromMarkdown(md: String): List<TocEntry> = tocFromBlocks(parseMarkdown(md))

// -- topic body (web MemoryTopicPage ArticleBody) ------------------------------

/** Article view body: the lead (currentState), else the full file. */
fun wikiBody(page: WikiPageResponse): String =
    if (page.currentState.isNotBlank()) page.currentState else page.markdown

/** `[[slug]]` wiki links → in-app markdown links (web wikiLinksToMarkdown). */
fun wikiLinksToMarkdown(md: String): String =
    md.replace(Regex("\\[\\[([a-z0-9-]{1,80})\\]\\]")) { m -> "[${m.groupValues[1]}](/memory/${m.groupValues[1]})" }

/** Short display date (yyyy-mm-dd) for the topic meta line. */
fun wikiDateLabel(iso: String?): String = iso?.take(10)?.ifBlank { null } ?: "—"

// -- datahub resolution (web wiki-base.ts datahubBaseFromMesh) -----------------

/** Pick the datahub node from the mesh roster (name/id match), else null → caller uses the entry gateway. */
fun datahubNode(nodes: List<NodeRef>): NodeRef? = nodes.firstOrNull { n ->
    val id = n.id.lowercase()
    val name = n.name.lowercase()
    id == "datahub" || name == "datahub" || name.contains("datahub")
}

/** A non-blank query drives server-side search regardless of the active tab (web MemoryPage). */
fun memorySearching(query: String): Boolean = query.trim().isNotEmpty()
