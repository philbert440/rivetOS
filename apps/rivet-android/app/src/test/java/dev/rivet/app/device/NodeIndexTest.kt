package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for pure NodeIndex resolve + DFS id assignment (PR3a).
 * No Android framework types. Targets [NodeResolve.kt] APIs.
 */
class NodeIndexTest {

    // ---- Mock tree ---------------------------------------------------------

    private data class MockNode(
        override val className: String = "android.widget.Button",
        override val viewId: String = "",
        override val text: String = "",
        override val contentDescription: String = "",
        override val packageName: String = "com.example",
        override val bounds: NodeBounds = NodeBounds(0, 0, 100, 100),
        val children: List<MockNode> = emptyList(),
    ) : ResolvableNode {
        override val childCount: Int get() = children.size
        override fun getChild(i: Int): ResolvableNode? = children.getOrNull(i)
    }

    private fun smallTree(): MockNode = MockNode(
        className = "android.widget.FrameLayout",
        viewId = "root",
        text = "",
        children = listOf(
            MockNode(
                className = "android.widget.TextView",
                viewId = "title",
                text = "Hello",
                bounds = NodeBounds(0, 0, 200, 50),
            ),
            MockNode(
                className = "android.widget.LinearLayout",
                viewId = "row",
                text = "",
                children = listOf(
                    MockNode(
                        className = "android.widget.Button",
                        viewId = "com.example:id/ok",
                        text = "OK",
                        bounds = NodeBounds(10, 60, 110, 120),
                    ),
                    MockNode(
                        className = "android.widget.Button",
                        viewId = "",
                        text = "Cancel",
                        contentDescription = "cancel-btn",
                        bounds = NodeBounds(120, 60, 220, 120),
                    ),
                    MockNode(
                        // Compose-style unlabeled
                        className = "android.view.View",
                        viewId = "",
                        text = "",
                        contentDescription = "",
                        bounds = NodeBounds(0, 200, 48, 248),
                    ),
                ),
            ),
        ),
    )

    private fun indexFrom(root: MockNode, created: Long = 1_000L, ttl: Long = 15_000L): NodeIndex {
        val dump = buildNodeDump(root, maxDepth = 12)
        return NodeIndex(
            dumpId = 1L,
            createdElapsedMs = created,
            ttlMs = ttl,
            byId = dump.byId,
        )
    }

    // ---- DFS id assignment -------------------------------------------------

    @Test
    fun `DFS assigns sequential n0 to nN`() {
        val root = smallTree()
        val dump = buildNodeDump(root, maxDepth = 12)
        // root + title + row + ok + cancel + compose = 6
        assertEquals(6, dump.nodes.size)
        assertEquals(listOf("n0", "n1", "n2", "n3", "n4", "n5"), dump.nodes.map { it.id })
        assertFalse(dump.truncated)

        assertEquals("", dump.nodes[0].pathString()) // root
        assertEquals("0", dump.nodes[1].pathString()) // title
        assertEquals("1", dump.nodes[2].pathString()) // row
        assertEquals("1/0", dump.nodes[3].pathString()) // ok
        assertEquals("1/1", dump.nodes[4].pathString()) // cancel
        assertEquals("1/2", dump.nodes[5].pathString()) // compose

        assertEquals(null, dump.nodes[0].pid)
        assertEquals("n0", dump.nodes[1].pid)
        assertEquals("n0", dump.nodes[2].pid)
        assertEquals("n2", dump.nodes[3].pid)
    }

    @Test
    fun `hard cap 500 truncates larger tree`() {
        var leaf = MockNode(className = "C", text = "leaf")
        repeat(599) {
            leaf = MockNode(className = "C", text = "n", children = listOf(leaf))
        }
        val dump = buildNodeDump(leaf, maxDepth = 10_000, limit = 0)
        assertEquals(500, dump.nodes.size)
        assertTrue(dump.truncated)
        assertEquals("n0", dump.nodes.first().id)
        assertEquals("n499", dump.nodes.last().id)
        assertEquals(500, effectiveNodeLimit(0))
        assertEquals(100, effectiveNodeLimit(100))
        assertEquals(500, effectiveNodeLimit(999))
    }

    // ---- Resolve: TTL / missing / path / identity --------------------------

    @Test
    fun `TTL expiry returns stale_node`() {
        val root = smallTree()
        val index = indexFrom(root, created = 1_000L, ttl = 15_000L)
        val status = resolveNode(index, "n3", nowElapsedMs = 1_000L + 15_001L, root = root)
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `missing id returns stale_node`() {
        val root = smallTree()
        val index = indexFrom(root)
        val status = resolveNode(index, "n999", nowElapsedMs = 1_000L, root = root)
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `null index returns stale_node`() {
        val status = resolveNode(null, "n0", nowElapsedMs = 1L, root = smallTree())
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `null root returns a11y_disconnected`() {
        val root = smallTree()
        val index = indexFrom(root)
        val status = resolveNode(index, "n0", nowElapsedMs = 1_000L, root = null)
        assertEquals(ResolveResult.A11yDisconnected, status)
    }

    @Test
    fun `happy path viewId identity accept`() {
        val root = smallTree()
        val index = indexFrom(root)
        val status = resolveNode(index, "n3", nowElapsedMs = 1_000L, root = root)
        assertTrue(status is ResolveResult.Accept)
    }

    @Test
    fun `happy path text contentDescription identity accept`() {
        val root = smallTree()
        val index = indexFrom(root)
        val status = resolveNode(index, "n4", nowElapsedMs = 1_000L, root = root)
        assertTrue(status is ResolveResult.Accept)
    }

    @Test
    fun `Compose bounds center within 48px accepts`() {
        val root = smallTree()
        val index = indexFrom(root)
        val live = MockNode(
            className = "android.view.View",
            viewId = "",
            text = "",
            contentDescription = "",
            bounds = NodeBounds(10, 210, 58, 258),
        )
        val shifted = MockNode(
            className = "android.widget.FrameLayout",
            viewId = "root",
            children = listOf(
                root.children[0],
                MockNode(
                    className = "android.widget.LinearLayout",
                    viewId = "row",
                    children = listOf(
                        root.children[1].children[0],
                        root.children[1].children[1],
                        live,
                    ),
                ),
            ),
        )
        val status = resolveNode(index, "n5", nowElapsedMs = 1_000L, root = shifted)
        assertTrue(status is ResolveResult.Accept)
    }

    @Test
    fun `Compose bounds center beyond 48px is stale_node`() {
        val root = smallTree()
        val index = indexFrom(root)
        val far = MockNode(
            className = "android.view.View",
            viewId = "",
            text = "",
            contentDescription = "",
            bounds = NodeBounds(200, 400, 248, 448),
        )
        val shifted = MockNode(
            className = "android.widget.FrameLayout",
            viewId = "root",
            children = listOf(
                root.children[0],
                MockNode(
                    className = "android.widget.LinearLayout",
                    viewId = "row",
                    children = listOf(
                        root.children[1].children[0],
                        root.children[1].children[1],
                        far,
                    ),
                ),
            ),
        )
        val status = resolveNode(index, "n5", nowElapsedMs = 1_000L, root = shifted)
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `path walk null child returns stale_node`() {
        val root = smallTree()
        val index = indexFrom(root)
        val shallow = MockNode(
            className = "android.widget.FrameLayout",
            viewId = "root",
            children = listOf(
                root.children[0],
                MockNode(
                    className = "android.widget.LinearLayout",
                    viewId = "row",
                    children = emptyList(),
                ),
            ),
        )
        val status = resolveNode(index, "n3", nowElapsedMs = 1_000L, root = shallow)
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `class match but identity fail returns stale_node`() {
        val root = smallTree()
        val index = indexFrom(root)
        val imposter = MockNode(
            className = "android.widget.Button",
            viewId = "com.example:id/other",
            text = "Nope",
            bounds = NodeBounds(10, 60, 110, 120),
        )
        val tree = MockNode(
            className = "android.widget.FrameLayout",
            viewId = "root",
            children = listOf(
                root.children[0],
                MockNode(
                    className = "android.widget.LinearLayout",
                    viewId = "row",
                    children = listOf(
                        imposter,
                        root.children[1].children[1],
                        root.children[1].children[2],
                    ),
                ),
            ),
        )
        val status = resolveNode(index, "n3", nowElapsedMs = 1_000L, root = tree)
        assertEquals(ResolveResult.StaleNode, status)
    }

    @Test
    fun `identityAccepts viewId takes priority over text`() {
        val ref = NodeRef(
            id = "n1",
            path = intArrayOf(0),
            className = "android.widget.Button",
            viewId = "id/a",
            text = "A",
            contentDescription = "",
            packageName = "p",
            boundsCenterX = 0,
            boundsCenterY = 0,
            bounds = NodeBounds(0, 0, 1, 1),
        )
        val sameViewIdDifferentText = MockNode(
            className = "android.widget.Button",
            viewId = "id/a",
            text = "B",
        )
        assertTrue(identityAccepts(ref, sameViewIdDifferentText))

        val differentViewId = MockNode(
            className = "android.widget.Button",
            viewId = "id/b",
            text = "A",
        )
        assertFalse(identityAccepts(ref, differentViewId))
    }

    // ---- HTTP mapping ------------------------------------------------------

    @Test
    fun `mapNodeAction stale is HTTP 400`() {
        val res = mapNodeActionClickToHttp("n1", NodeClickOutcome.StaleNode, executedAt = 42L)
        assertEquals(400, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("stale_node", body.getString("error"))
        assertFalse(body.getBoolean("ok"))
    }

    @Test
    fun `mapNodeAction a11y is HTTP 503`() {
        val res = mapNodeActionClickToHttp("n1", NodeClickOutcome.A11yDisconnected, executedAt = 42L)
        assertEquals(503, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("a11y_disconnected", body.getString("error"))
    }

    @Test
    fun `mapNodeAction success envelope has node_action fields`() {
        val res = mapNodeActionClickToHttp(
            "n17",
            NodeClickOutcome.PerformClickOk(durationMs = 12L),
            executedAt = 99L,
        )
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("node_action", body.getString("type"))
        assertEquals("n17", body.getString("nodeId"))
        assertEquals("click", body.getString("action"))
        assertTrue(body.getBoolean("completed"))
        assertEquals(12, body.getLong("durationMs"))
    }

    @Test
    fun `mapNodeAction gesture busy is HTTP 429`() {
        val res = mapNodeActionClickToHttp(
            "n1",
            NodeClickOutcome.GestureFallback(GestureAwaitOutcome.Busy),
        )
        assertEquals(429, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("busy", body.getString("error"))
    }
}
