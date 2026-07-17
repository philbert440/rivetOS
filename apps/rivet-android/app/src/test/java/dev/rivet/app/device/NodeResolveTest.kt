package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for pure NodeIndex resolve + DFS id assignment (PR3a).
 * No Android framework dependencies.
 */
class NodeResolveTest {

    // ---- Mock tree ---------------------------------------------------------

    private data class MockNode(
        override val className: String = "android.widget.Button",
        override val viewId: String = "",
        override val text: String = "",
        override val contentDescription: String = "",
        override val packageName: String = "dev.example",
        override val bounds: NodeBounds = NodeBounds(0, 0, 100, 100),
        private val children: List<MockNode> = emptyList(),
    ) : ResolvableNode {
        override val childCount: Int get() = children.size
        override fun getChild(i: Int): ResolvableNode? = children.getOrNull(i)
    }

    private fun ref(
        id: String,
        path: IntArray,
        className: String = "android.widget.Button",
        viewId: String = "",
        text: String = "",
        contentDescription: String = "",
        packageName: String = "dev.example",
        cx: Int = 50,
        cy: Int = 50,
        bounds: NodeBounds = NodeBounds(0, 0, 100, 100),
    ) = NodeRef(
        id = id,
        path = path,
        className = className,
        viewId = viewId,
        text = text,
        contentDescription = contentDescription,
        packageName = packageName,
        boundsCenterX = cx,
        boundsCenterY = cy,
        bounds = bounds,
    )

    private fun indexOf(vararg refs: NodeRef, created: Long = 1_000L, ttl: Long = NODE_INDEX_TTL_MS) =
        NodeIndex(
            dumpId = 1L,
            createdElapsedMs = created,
            ttlMs = ttl,
            byId = refs.associateBy { it.id },
        )

    // ---- TTL / missing id --------------------------------------------------

    @Test
    fun `null index is stale_node`() {
        val r = resolveNode(null, "n0", nowElapsedMs = 0L, root = MockNode())
        assertEquals(ResolveResult.StaleNode, r)
    }

    @Test
    fun `TTL expiry is stale_node`() {
        val idx = indexOf(ref("n0", intArrayOf()), created = 1_000L, ttl = 15_000L)
        val r = resolveNode(idx, "n0", nowElapsedMs = 1_000L + 15_001L, root = MockNode())
        assertEquals(ResolveResult.StaleNode, r)
    }

    @Test
    fun `TTL boundary still valid at exactly ttl`() {
        // elapsed - created > ttl → stale; equal is still valid
        val idx = indexOf(ref("n0", intArrayOf(), viewId = "x"), created = 1_000L, ttl = 15_000L)
        val root = MockNode(viewId = "x")
        val r = resolveNode(idx, "n0", nowElapsedMs = 1_000L + 15_000L, root = root)
        assertTrue(r is ResolveResult.Accept)
    }

    @Test
    fun `missing id is stale_node`() {
        val idx = indexOf(ref("n0", intArrayOf()))
        val r = resolveNode(idx, "n99", nowElapsedMs = 1_000L, root = MockNode())
        assertEquals(ResolveResult.StaleNode, r)
    }

    @Test
    fun `null root is a11y_disconnected`() {
        val idx = indexOf(ref("n0", intArrayOf()))
        val r = resolveNode(idx, "n0", nowElapsedMs = 1_000L, root = null)
        assertEquals(ResolveResult.A11yDisconnected, r)
    }

    // ---- Path walk ---------------------------------------------------------

    @Test
    fun `null child on path is stale_node`() {
        val idx = indexOf(ref("n1", intArrayOf(0), viewId = "btn"))
        // Root has no children → getChild(0) null
        val r = resolveNode(idx, "n1", nowElapsedMs = 1_000L, root = MockNode())
        assertEquals(ResolveResult.StaleNode, r)
    }

    @Test
    fun `happy path walk with viewId identity`() {
        val leaf = MockNode(viewId = "com.app:id/ok", text = "OK")
        val root = MockNode(children = listOf(MockNode(children = listOf(leaf))))
        val idx = indexOf(
            ref("n2", intArrayOf(0, 0), viewId = "com.app:id/ok", text = "OK"),
            created = 500L,
        )
        val r = resolveNode(idx, "n2", nowElapsedMs = 500L, root = root)
        assertTrue(r is ResolveResult.Accept)
        assertEquals("com.app:id/ok", (r as ResolveResult.Accept).node.viewId)
    }

    // ---- Identity: text / Compose bounds -----------------------------------

    @Test
    fun `text identity accepts case-sensitive match`() {
        val leaf = MockNode(viewId = "", text = "Settings")
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(ref("n1", intArrayOf(0), text = "Settings"))
        assertTrue(resolveNode(idx, "n1", 1_000L, root) is ResolveResult.Accept)
    }

    @Test
    fun `text identity rejects case mismatch`() {
        val leaf = MockNode(viewId = "", text = "settings")
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(ref("n1", intArrayOf(0), text = "Settings"))
        assertEquals(ResolveResult.StaleNode, resolveNode(idx, "n1", 1_000L, root))
    }

    @Test
    fun `Compose bounds-center within 48px accepts`() {
        val leaf = MockNode(
            viewId = "",
            text = "",
            contentDescription = "",
            bounds = NodeBounds(10, 10, 90, 90), // center 50,50
        )
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(
            ref(
                "n1",
                intArrayOf(0),
                viewId = "",
                text = "",
                contentDescription = "",
                cx = 50 + 30, // 30px away < 48
                cy = 50,
                bounds = NodeBounds(40, 10, 120, 90),
            ),
        )
        assertTrue(resolveNode(idx, "n1", 1_000L, root) is ResolveResult.Accept)
    }

    @Test
    fun `Compose bounds-center beyond 48px is stale_node`() {
        val leaf = MockNode(
            viewId = "",
            text = "",
            contentDescription = "",
            bounds = NodeBounds(0, 0, 100, 100), // center 50,50
        )
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(
            ref(
                "n1",
                intArrayOf(0),
                viewId = "",
                text = "",
                contentDescription = "",
                cx = 50 + 49, // 49px > 48
                cy = 50,
            ),
        )
        assertEquals(ResolveResult.StaleNode, resolveNode(idx, "n1", 1_000L, root))
    }

    @Test
    fun `class match but viewId identity fail is stale_node`() {
        val leaf = MockNode(className = "android.widget.Button", viewId = "other")
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(
            ref("n1", intArrayOf(0), className = "android.widget.Button", viewId = "wanted"),
        )
        assertEquals(ResolveResult.StaleNode, resolveNode(idx, "n1", 1_000L, root))
    }

    @Test
    fun `class mismatch is stale_node even if text matches`() {
        val leaf = MockNode(className = "android.widget.TextView", text = "Hi")
        val root = MockNode(children = listOf(leaf))
        val idx = indexOf(
            ref("n1", intArrayOf(0), className = "android.widget.Button", text = "Hi"),
        )
        assertEquals(ResolveResult.StaleNode, resolveNode(idx, "n1", 1_000L, root))
    }

    // ---- DFS id assignment + hard cap --------------------------------------

    @Test
    fun `DFS ids are sequential n0 to nN`() {
        // tree: root → A, B→C  => order n0=root, n1=A, n2=B, n3=C
        val c = MockNode(text = "C")
        val b = MockNode(text = "B", children = listOf(c))
        val a = MockNode(text = "A")
        val root = MockNode(text = "R", children = listOf(a, b))
        val dump = buildNodeDump(root, maxDepth = 12, limit = 0)
        assertEquals(4, dump.nodes.size)
        assertEquals(listOf("n0", "n1", "n2", "n3"), dump.nodes.map { it.id })
        assertEquals(null, dump.nodes[0].pid)
        assertEquals("n0", dump.nodes[1].pid)
        assertEquals("n0", dump.nodes[2].pid)
        assertEquals("n2", dump.nodes[3].pid)
        assertEquals("", dump.nodes[0].pathString())
        assertEquals("0", dump.nodes[1].pathString())
        assertEquals("1", dump.nodes[2].pathString())
        assertEquals("1/0", dump.nodes[3].pathString())
        assertFalse(dump.truncated)
        assertEquals(setOf("n0", "n1", "n2", "n3"), dump.byId.keys)
    }

    @Test
    fun `hard cap 500 emits 500 and sets truncated on larger tree`() {
        // Build a flat fan-out: root + 600 leaves = 601 nodes
        val leaves = List(600) { i -> MockNode(text = "L$i") }
        val root = MockNode(text = "root", children = leaves)
        val dump = buildNodeDump(root, maxDepth = 12, limit = 0)
        assertEquals(NODE_HARD_CAP, dump.nodes.size)
        assertTrue(dump.truncated)
        assertEquals("n0", dump.nodes.first().id)
        assertEquals("n499", dump.nodes.last().id)
        assertEquals(NODE_HARD_CAP, dump.byId.size)
    }

    @Test
    fun `limit is emission-only walk always hard-capped`() {
        // PR3b: buildNodeDump ignores limit for the walk so NodeIndex stays complete.
        val leaves = List(50) { MockNode() }
        val root = MockNode(children = leaves)
        val dump = buildNodeDump(root, maxDepth = 12, limit = 10)
        assertEquals(51, dump.nodes.size) // root + 50 leaves
        assertFalse(dump.truncated)
        val (emitted, emitTrunc) = selectEmittedNodes(
            dump.nodes,
            UiDumpFormat.FLAT,
            UiDumpFilters(visibleOnly = false),
            limit = 10,
        )
        assertEquals(10, emitted.size)
        assertTrue(emitTrunc)
        assertEquals(51, dump.byId.size)
    }

    @Test
    fun `effectiveNodeLimit clamps`() {
        assertEquals(NODE_HARD_CAP, effectiveNodeLimit(0))
        assertEquals(NODE_HARD_CAP, effectiveNodeLimit(-1))
        assertEquals(NODE_HARD_CAP, effectiveNodeLimit(9999))
        assertEquals(42, effectiveNodeLimit(42))
        assertEquals(Int.MAX_VALUE, effectiveEmitLimit(0))
        assertEquals(10, effectiveEmitLimit(10))
    }

    // ---- HTTP envelope for node_action -------------------------------------

    @Test
    fun `mapNodeActionClickToHttp stale_node is 400`() {
        val res = mapNodeActionClickToHttp("n7", NodeClickOutcome.StaleNode)
        assertEquals(400, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("stale_node", body.getString("error"))
        assertFalse(body.getBoolean("ok"))
    }

    @Test
    fun `mapNodeActionClickToHttp a11y_disconnected is 503`() {
        val res = mapNodeActionClickToHttp("n7", NodeClickOutcome.A11yDisconnected)
        assertEquals(503, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("a11y_disconnected", body.getString("error"))
    }

    @Test
    fun `mapNodeActionClickToHttp perform click ok envelope`() {
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
        assertEquals(12L, body.getLong("durationMs"))
        assertEquals(99L, body.getLong("executed_at"))
    }

    @Test
    fun `mapNodeActionClickToHttp gesture busy is 429`() {
        val res = mapNodeActionClickToHttp(
            "n1",
            NodeClickOutcome.GestureFallback(GestureAwaitOutcome.Busy),
        )
        assertEquals(429, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("busy", body.getString("error"))
        assertEquals("gesture_busy", body.getString("message"))
    }
}
