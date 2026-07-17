package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.regex.Pattern

/**
 * JVM unit tests for PR3b `/ui` formats + filters (pure projection over mock trees).
 * No Android framework types.
 */
class UiDumpTest {

    private data class MockNode(
        override val className: String = "android.widget.FrameLayout",
        override val viewId: String = "",
        override val text: String = "",
        override val contentDescription: String = "",
        override val packageName: String = "com.example",
        override val bounds: NodeBounds = NodeBounds(0, 0, 100, 100),
        override val clickable: Boolean = false,
        override val editable: Boolean = false,
        override val focusable: Boolean = false,
        override val focused: Boolean = false,
        override val scrollable: Boolean = false,
        override val enabled: Boolean = true,
        override val checked: Boolean = false,
        override val selected: Boolean = false,
        override val visible: Boolean = true,
        override val hint: String = "",
        val children: List<MockNode> = emptyList(),
    ) : ResolvableNode {
        override val childCount: Int get() = children.size
        override fun getChild(i: Int): ResolvableNode? = children.getOrNull(i)
    }

    /**
     * root (n0, visible container)
     *  ├─ title TextView "Hello" (n1)
     *  ├─ ok Button clickable (n2)
     *  ├─ field EditText editable (n3)
     *  ├─ list scrollable (n4)
     *  └─ hidden Button clickable visible=false (n5)
     */
    private fun sampleTree(): MockNode = MockNode(
        className = "android.widget.FrameLayout",
        viewId = "root",
        packageName = "com.example",
        children = listOf(
            MockNode(
                className = "android.widget.TextView",
                viewId = "title",
                text = "Hello World",
                packageName = "com.example",
            ),
            MockNode(
                className = "android.widget.Button",
                viewId = "com.example:id/ok",
                text = "OK",
                clickable = true,
                packageName = "com.example",
            ),
            MockNode(
                className = "android.widget.EditText",
                viewId = "com.example:id/field",
                text = "typed",
                editable = true,
                packageName = "com.example",
                hint = "Name",
            ),
            MockNode(
                className = "android.widget.ScrollView",
                viewId = "list",
                scrollable = true,
                packageName = "com.example",
                children = listOf(
                    MockNode(
                        className = "android.widget.TextView",
                        text = "Row",
                        packageName = "com.example",
                    ),
                ),
            ),
            MockNode(
                className = "android.widget.Button",
                viewId = "hidden_btn",
                text = "Ghost",
                clickable = true,
                visible = false,
                packageName = "com.other",
            ),
        ),
    )

    // ---- parseUiQuery ------------------------------------------------------

    @Test
    fun `parseUiQuery defaults`() {
        val r = parseUiQuery(emptyMap())
        assertTrue(r is ParseUiQueryResult.Ok)
        val q = (r as ParseUiQueryResult.Ok).query
        assertEquals(UiDumpFormat.FLAT, q.format)
        assertEquals(12, q.maxDepth)
        assertTrue(q.includeBounds)
        assertEquals(0, q.limit)
        assertNull(q.fields)
        assertTrue(q.filters.visibleOnly)
        assertFalse(q.filters.clickableOnly)
    }

    @Test
    fun `parseUiQuery rejects unknown format`() {
        val r = parseUiQuery(mapOf("format" to "xml"))
        assertTrue(r is ParseUiQueryResult.BadRequest)
    }

    @Test
    fun `parseUiQuery rejects textRegex longer than 64`() {
        val r = parseUiQuery(mapOf("textRegex" to "a".repeat(65)))
        assertTrue(r is ParseUiQueryResult.BadRequest)
        assertTrue((r as ParseUiQueryResult.BadRequest).message.contains("64"))
    }

    @Test
    fun `parseUiQuery rejects invalid textRegex`() {
        val r = parseUiQuery(mapOf("textRegex" to "("))
        assertTrue(r is ParseUiQueryResult.BadRequest)
        assertTrue((r as ParseUiQueryResult.BadRequest).message.contains("pattern"))
    }

    @Test
    fun `parseUiQuery accepts valid textRegex`() {
        val r = parseUiQuery(mapOf("textRegex" to "Hel+o"))
        assertTrue(r is ParseUiQueryResult.Ok)
        assertNotNull((r as ParseUiQueryResult.Ok).query.filters.textRegex)
    }

    @Test
    fun `parseUiQuery parses filters and fields`() {
        val r = parseUiQuery(
            mapOf(
                "format" to "compact",
                "clickable" to "1",
                "editable" to "true",
                "text" to "hi",
                "textExact" to "OK",
                "viewId" to "id/ok",
                "package" to "com.example",
                "class" to "Button",
                "visible" to "0",
                "fields" to "id,text,clickable",
                "limit" to "10",
                "bounds" to "0",
            ),
        )
        assertTrue(r is ParseUiQueryResult.Ok)
        val q = (r as ParseUiQueryResult.Ok).query
        assertEquals(UiDumpFormat.COMPACT, q.format)
        assertTrue(q.filters.clickableOnly)
        assertTrue(q.filters.editableOnly)
        assertEquals("hi", q.filters.textContains)
        assertEquals("OK", q.filters.textExact)
        assertEquals("id/ok", q.filters.viewIdContains)
        assertEquals("com.example", q.filters.packageEquals)
        assertEquals("Button", q.filters.classContains)
        assertFalse(q.filters.visibleOnly)
        assertEquals(setOf("id", "text", "clickable"), q.fields)
        assertEquals(10, q.limit)
        assertFalse(q.includeBounds)
    }

    // ---- filters -----------------------------------------------------------

    @Test
    fun `clickable filter includes only clickable`() {
        val dump = buildNodeDump(sampleTree())
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(clickableOnly = true, visibleOnly = false),
        )
        assertTrue(emitted.isNotEmpty())
        assertTrue(emitted.all { it.clickable })
        assertTrue(emitted.any { it.text == "OK" })
        assertTrue(emitted.any { it.text == "Ghost" })
    }

    @Test
    fun `editable filter includes only editable`() {
        val dump = buildNodeDump(sampleTree())
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(editableOnly = true),
        )
        assertEquals(1, emitted.size)
        assertEquals("typed", emitted[0].text)
        assertTrue(emitted[0].editable)
    }

    @Test
    fun `text contains is case-insensitive on text and contentDescription`() {
        val root = MockNode(
            children = listOf(
                MockNode(text = "Hello"),
                MockNode(contentDescription = "WORLD"),
                MockNode(text = "nope"),
            ),
        )
        val dump = buildNodeDump(root)
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(textContains = "hello"),
        )
        assertEquals(1, emitted.size)
        assertEquals("Hello", emitted[0].text)

        val (emitted2, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(textContains = "world"),
        )
        assertEquals(1, emitted2.size)
        assertEquals("WORLD", emitted2[0].contentDescription)
    }

    @Test
    fun `textExact is exact not contains`() {
        val root = MockNode(
            children = listOf(
                MockNode(text = "OK"),
                MockNode(text = "OK Button"),
            ),
        )
        val dump = buildNodeDump(root)
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(textExact = "OK"),
        )
        assertEquals(1, emitted.size)
        assertEquals("OK", emitted[0].text)
    }

    @Test
    fun `viewId contains package equals class contains`() {
        val dump = buildNodeDump(sampleTree())
        val (byView, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(viewIdContains = "id/ok", visibleOnly = false),
        )
        assertEquals(1, byView.size)
        assertEquals("OK", byView[0].text)

        val (byPkg, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(packageEquals = "com.other", visibleOnly = false),
        )
        assertEquals(1, byPkg.size)
        assertEquals("Ghost", byPkg[0].text)

        val (byClass, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(classContains = "edittext"),
        )
        assertEquals(1, byClass.size)
        assertTrue(byClass[0].editable)
    }

    @Test
    fun `visible default drops invisible nodes`() {
        val dump = buildNodeDump(sampleTree())
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(visibleOnly = true),
        )
        assertFalse(emitted.any { it.text == "Ghost" })
        val (withHidden, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(visibleOnly = false),
        )
        assertTrue(withHidden.any { it.text == "Ghost" })
    }

    @Test
    fun `textRegex matches and rejects length via parse`() {
        val dump = buildNodeDump(sampleTree())
        val pat = Pattern.compile("Hel+o")
        val (emitted, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(textRegex = pat),
        )
        assertEquals(1, emitted.size)
        assertTrue(emitted[0].text.contains("Hello"))
    }

    // ---- compact / ids / tree / limit / fields -----------------------------

    @Test
    fun `compact keeps interesting nodes and same ids as flat`() {
        val dump = buildNodeDump(sampleTree())
        // Full flat (ignore visible default for id comparison of interesting set)
        val flatIds = dump.nodes.map { it.id }
        assertEquals(listOf("n0", "n1", "n2", "n3", "n4", "n5", "n6"), flatIds)

        val (compact, _) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.COMPACT,
            UiDumpFilters(visibleOnly = false),
        )
        // interesting: Hello text, OK clickable, field editable+text, scroll list, Ghost clickable+text
        // root empty container not interesting; Row text is interesting
        val compactIds = compact.map { it.id }
        assertTrue(compactIds.contains("n1")) // Hello
        assertTrue(compactIds.contains("n2")) // OK
        assertTrue(compactIds.contains("n3")) // field
        assertTrue(compactIds.contains("n4")) // scroll
        assertTrue(compactIds.contains("n5")) // Row text under scroll
        assertTrue(compactIds.contains("n6")) // Ghost
        assertFalse(compactIds.contains("n0")) // bare root

        // ids identical to flat assignment for those nodes
        for (n in compact) {
            val flat = dump.nodes.first { it.id == n.id }
            assertEquals(flat.pathString(), n.pathString())
            assertEquals(flat.text, n.text)
        }
        // index has full tree including non-emitted root
        assertEquals(7, dump.byId.size)
        assertTrue(dump.byId.containsKey("n0"))
    }

    @Test
    fun `tree nesting structure correct`() {
        val dump = buildNodeDump(sampleTree())
        val json = projectUiDump(
            dump,
            format = UiDumpFormat.TREE,
            filters = UiDumpFilters(visibleOnly = false),
            packageName = "com.example",
            timestamp = 1L,
            dumpId = 1L,
        )
        assertEquals("tree", json.getString("format"))
        val roots = json.getJSONArray("nodes")
        assertEquals(1, roots.length())
        val root = roots.getJSONObject(0)
        assertEquals("n0", root.getString("id"))
        val kids = root.getJSONArray("children")
        // title, ok, field, scroll, hidden = 5
        assertEquals(5, kids.length())
        val scroll = kids.getJSONObject(3)
        assertTrue(scroll.getBoolean("scrollable"))
        assertEquals(1, scroll.getJSONArray("children").length())
        assertEquals("Row", scroll.getJSONArray("children").getJSONObject(0).getString("text"))
    }

    @Test
    fun `tree reparents when intermediate filtered out`() {
        val dump = buildNodeDump(sampleTree())
        // Only text "Row" — its parent scroll is not emitted; should appear as top-level
        val json = projectUiDump(
            dump,
            format = UiDumpFormat.TREE,
            filters = UiDumpFilters(textExact = "Row"),
            timestamp = 1L,
            dumpId = 1L,
        )
        val roots = json.getJSONArray("nodes")
        assertEquals(1, roots.length())
        assertEquals("Row", roots.getJSONObject(0).getString("text"))
        assertEquals(0, roots.getJSONObject(0).getJSONArray("children").length())
    }

    @Test
    fun `limit caps emitted count not index size`() {
        val dump = buildNodeDump(sampleTree())
        assertEquals(7, dump.byId.size)
        val (emitted, truncated) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(visibleOnly = false),
            limit = 3,
        )
        assertEquals(3, emitted.size)
        assertTrue(truncated)
        // Index still full
        assertEquals(7, dump.byId.size)
    }

    @Test
    fun `hard cap 500 still enforced on walk`() {
        var leaf = MockNode(className = "C", text = "leaf")
        repeat(599) {
            leaf = MockNode(className = "C", text = "n", children = listOf(leaf))
        }
        val dump = buildNodeDump(leaf, maxDepth = 10_000)
        assertEquals(500, dump.nodes.size)
        assertTrue(dump.truncated)
        assertEquals(500, dump.byId.size)
        // emit limit does not shrink index
        val (emitted, _) = selectEmittedNodes(dump.nodes, UiDumpFormat.FLAT, limit = 10)
        assertEquals(10, emitted.size)
        assertEquals(500, dump.byId.size)
    }

    @Test
    fun `fields allowlist slims output but always keeps id`() {
        val dump = buildNodeDump(sampleTree())
        val n = dump.nodes.first { it.text == "OK" }
        val slim = flatDumpNodeToJson(n, includeBounds = true, fields = setOf("text", "clickable"))
        assertTrue(slim.has("id"))
        assertEquals("OK", slim.getString("text"))
        assertTrue(slim.getBoolean("clickable"))
        assertFalse(slim.has("class"))
        assertFalse(slim.has("bounds"))
        assertFalse(slim.has("pid"))
    }

    @Test
    fun `fields with bounds=false omits bounds`() {
        val dump = buildNodeDump(sampleTree())
        val n = dump.nodes[0]
        val obj = flatDumpNodeToJson(n, includeBounds = false, fields = setOf("id", "bounds"))
        assertTrue(obj.has("id"))
        assertFalse(obj.has("bounds"))
    }

    @Test
    fun `projectUiDump flat includes editable and format`() {
        val dump = buildNodeDump(sampleTree())
        val json = projectUiDump(
            dump,
            format = UiDumpFormat.FLAT,
            filters = UiDumpFilters(editableOnly = true),
            timestamp = 42L,
            dumpId = 42L,
            packageName = "com.example",
        )
        assertEquals("flat", json.getString("format"))
        assertEquals(1, json.getJSONArray("nodes").length())
        val node = json.getJSONArray("nodes").getJSONObject(0)
        assertTrue(node.getBoolean("editable"))
        assertEquals("typed", node.getString("text"))
        assertEquals(42L, json.getLong("dumpId"))
    }

    @Test
    fun `ids identical across formats for same tree`() {
        val dump = buildNodeDump(sampleTree())
        val flatJson = projectUiDump(dump, UiDumpFormat.FLAT, UiDumpFilters(visibleOnly = false), timestamp = 1L, dumpId = 1L)
        val compactJson = projectUiDump(dump, UiDumpFormat.COMPACT, UiDumpFilters(visibleOnly = false), timestamp = 1L, dumpId = 1L)
        val treeJson = projectUiDump(dump, UiDumpFormat.TREE, UiDumpFilters(visibleOnly = false), timestamp = 1L, dumpId = 1L)

        fun collectIds(arr: org.json.JSONArray, into: MutableSet<String>) {
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                into.add(o.getString("id"))
                if (o.has("children")) collectIds(o.getJSONArray("children"), into)
            }
        }

        val flatIds = (0 until flatJson.getJSONArray("nodes").length()).map {
            flatJson.getJSONArray("nodes").getJSONObject(it).getString("id")
        }.toSet()
        val compactIds = (0 until compactJson.getJSONArray("nodes").length()).map {
            compactJson.getJSONArray("nodes").getJSONObject(it).getString("id")
        }.toSet()
        val treeIds = mutableSetOf<String>()
        collectIds(treeJson.getJSONArray("nodes"), treeIds)

        assertEquals(flatIds, treeIds)
        assertTrue(flatIds.containsAll(compactIds))
        // OK button same id in all formats
        val okFlat = (0 until flatJson.getJSONArray("nodes").length())
            .map { flatJson.getJSONArray("nodes").getJSONObject(it) }
            .first { it.optString("text") == "OK" }
            .getString("id")
        assertTrue(compactIds.contains(okFlat))
        assertTrue(treeIds.contains(okFlat))
    }

    @Test
    fun `effectiveNodeLimit still documents hard cap`() {
        assertEquals(500, effectiveNodeLimit(0))
        assertEquals(100, effectiveNodeLimit(100))
        assertEquals(500, effectiveNodeLimit(999))
        assertEquals(Int.MAX_VALUE, effectiveEmitLimit(0))
        assertEquals(10, effectiveEmitLimit(10))
    }
}
