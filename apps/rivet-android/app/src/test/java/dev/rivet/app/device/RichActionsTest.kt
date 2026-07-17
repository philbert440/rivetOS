package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for pure rich-action helpers (PR4).
 */
class RichActionsTest {

    // ---- node_action name → ACTION id --------------------------------------

    @Test
    fun `mapNodeActionNameToActionId known actions`() {
        assertEquals(A11Y_ACTION_CLICK, mapNodeActionNameToActionId("click"))
        assertEquals(A11Y_ACTION_LONG_CLICK, mapNodeActionNameToActionId("LONG_CLICK"))
        assertEquals(A11Y_ACTION_FOCUS, mapNodeActionNameToActionId("focus"))
        assertEquals(A11Y_ACTION_SET_TEXT, mapNodeActionNameToActionId("set_text"))
        assertEquals(A11Y_ACTION_SCROLL_FORWARD, mapNodeActionNameToActionId("scroll_forward"))
        assertEquals(A11Y_ACTION_SCROLL_BACKWARD, mapNodeActionNameToActionId("scroll_backward"))
        assertEquals(A11Y_ACTION_SELECT, mapNodeActionNameToActionId("select"))
    }

    @Test
    fun `mapNodeActionNameToActionId unknown is null`() {
        assertNull(mapNodeActionNameToActionId("swipe"))
        assertNull(mapNodeActionNameToActionId(""))
        assertNull(mapNodeActionNameToActionId("double_tap"))
    }

    @Test
    fun `NODE_ACTION_NAMES lists all mappable actions`() {
        for (name in NODE_ACTION_NAMES) {
            assertNotNull("missing mapping for $name", mapNodeActionNameToActionId(name))
        }
        assertEquals(7, NODE_ACTION_NAMES.size)
    }

    @Test
    fun `nodeActionRequiresText only set_text`() {
        assertTrue(nodeActionRequiresText("set_text"))
        assertTrue(nodeActionRequiresText("SET_TEXT"))
        assertFalse(nodeActionRequiresText("click"))
        assertFalse(nodeActionRequiresText("focus"))
    }

    // ---- scroll direction --------------------------------------------------

    @Test
    fun `ScrollDirection parse`() {
        assertEquals(ScrollDirection.UP, ScrollDirection.parse("up"))
        assertEquals(ScrollDirection.DOWN, ScrollDirection.parse("DOWN"))
        assertEquals(ScrollDirection.LEFT, ScrollDirection.parse("left"))
        assertEquals(ScrollDirection.RIGHT, ScrollDirection.parse("right"))
        assertNull(ScrollDirection.parse("diagonal"))
        assertNull(ScrollDirection.parse(null))
        assertNull(ScrollDirection.parse(""))
    }

    @Test
    fun `scrollDirectionToForwardBackward mapping`() {
        assertEquals(A11Y_ACTION_SCROLL_FORWARD, scrollDirectionToForwardBackward(ScrollDirection.DOWN))
        assertEquals(A11Y_ACTION_SCROLL_FORWARD, scrollDirectionToForwardBackward(ScrollDirection.RIGHT))
        assertEquals(A11Y_ACTION_SCROLL_BACKWARD, scrollDirectionToForwardBackward(ScrollDirection.UP))
        assertEquals(A11Y_ACTION_SCROLL_BACKWARD, scrollDirectionToForwardBackward(ScrollDirection.LEFT))
    }

    @Test
    fun `scrollDirectionToSwipe finger moves opposite content`() {
        val down = scrollDirectionToSwipe(ScrollDirection.DOWN, centerX = 100, centerY = 200, spanPx = 100)
        // finger up: y1 > y2
        assertTrue(down.y1 > down.y2)
        assertEquals(100, down.x1)
        assertEquals(100, down.x2)

        val up = scrollDirectionToSwipe(ScrollDirection.UP, 100, 200, 100)
        assertTrue(up.y1 < up.y2)

        val right = scrollDirectionToSwipe(ScrollDirection.RIGHT, 100, 200, 100)
        assertTrue(right.x1 > right.x2)

        val left = scrollDirectionToSwipe(ScrollDirection.LEFT, 100, 200, 100)
        assertTrue(left.x1 < left.x2)
    }

    @Test
    fun `scrollSpanFromBounds floors at min`() {
        assertEquals(SCROLL_SWIPE_MIN_SPAN_PX, scrollSpanFromBounds(10, 10))
        val wide = scrollSpanFromBounds(1000, 100)
        assertEquals((1000 * SCROLL_SWIPE_SPAN_FRACTION).toInt(), wide)
    }

    // ---- long_press duration -----------------------------------------------

    @Test
    fun `longPressDurationMs clamps to minimum 600`() {
        assertEquals(LONG_PRESS_MIN_DURATION_MS, longPressDurationMs(null))
        assertEquals(LONG_PRESS_MIN_DURATION_MS, longPressDurationMs(0L))
        assertEquals(LONG_PRESS_MIN_DURATION_MS, longPressDurationMs(100L))
        assertEquals(LONG_PRESS_MIN_DURATION_MS, longPressDurationMs(600L))
        assertEquals(900L, longPressDurationMs(900L))
    }

    // ---- text append / mode ------------------------------------------------

    @Test
    fun `resolveTextPayload replace and append`() {
        assertEquals("hello", resolveTextPayload("replace", "old", "hello"))
        assertEquals("oldhello", resolveTextPayload("append", "old", "hello"))
        assertEquals("hello", resolveTextPayload("REPLACE", "old", "hello"))
        assertEquals("ab", resolveTextPayload("append", "a", "b"))
        assertEquals("x", resolveTextPayload("append", "", "x"))
    }

    @Test
    fun `parseTextMode`() {
        assertEquals("replace", parseTextMode(null))
        assertEquals("replace", parseTextMode(""))
        assertEquals("replace", parseTextMode("replace"))
        assertEquals("append", parseTextMode("APPEND"))
        assertNull(parseTextMode("merge"))
        assertNull(parseTextMode("prepend"))
    }

    // ---- mapNodeActionToHttp -----------------------------------------------

    @Test
    fun `mapNodeActionToHttp perform ok carries action name`() {
        val res = mapNodeActionToHttp(
            nodeId = "n3",
            action = "long_click",
            outcome = NodeActionOutcome.PerformOk(durationMs = 5L),
            executedAt = 11L,
        )
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("node_action", body.getString("type"))
        assertEquals("n3", body.getString("nodeId"))
        assertEquals("long_click", body.getString("action"))
        assertTrue(body.getBoolean("completed"))
        assertEquals(5L, body.getLong("durationMs"))
        assertEquals(11L, body.getLong("executed_at"))
    }

    @Test
    fun `mapNodeActionToHttp responseType override for long_press`() {
        val res = mapNodeActionToHttp(
            nodeId = "n1",
            action = "long_click",
            outcome = NodeActionOutcome.PerformOk(durationMs = 1L),
            responseType = "long_press",
        )
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("long_press", body.getString("type"))
        assertEquals("long_click", body.getString("action"))
    }

    @Test
    fun `mapNodeActionToHttp action_failed envelope`() {
        val res = mapNodeActionToHttp("n2", "focus", NodeActionOutcome.ActionFailed)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("action_failed", body.getString("error"))
        assertEquals("focus", body.getString("action"))
        assertFalse(body.getBoolean("completed"))
    }

    @Test
    fun `mapNodeActionToHttp stale and a11y`() {
        val stale = mapNodeActionToHttp("n0", "click", NodeActionOutcome.StaleNode)
        assertEquals(400, stale.code)
        assertEquals("stale_node", JSONObject(stale.body.toString(Charsets.UTF_8)).getString("error"))

        val disc = mapNodeActionToHttp("n0", "click", NodeActionOutcome.A11yDisconnected)
        assertEquals(503, disc.code)
        assertEquals(
            "a11y_disconnected",
            JSONObject(disc.body.toString(Charsets.UTF_8)).getString("error"),
        )
    }

    @Test
    fun `mapNodeActionToHttp gesture busy is 429`() {
        val res = mapNodeActionToHttp(
            "n1",
            "click",
            NodeActionOutcome.GestureFallback(GestureAwaitOutcome.Busy),
        )
        assertEquals(429, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("busy", body.getString("error"))
    }

    @Test
    fun `mapNodeActionClickToHttp still works via delegation`() {
        val res = mapNodeActionClickToHttp(
            "n17",
            NodeClickOutcome.PerformClickOk(durationMs = 12L),
            executedAt = 99L,
        )
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertEquals("click", body.getString("action"))
        assertEquals("node_action", body.getString("type"))
        assertTrue(body.getBoolean("ok"))
    }

    // ---- clipboard envelopes -----------------------------------------------

    @Test
    fun `clipboardGetResponse shape`() {
        val res = clipboardGetResponse("hello", executedAt = 5L)
        assertEquals(200, res.code)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("clipboard", body.getString("type"))
        assertEquals("get", body.getString("op"))
        assertEquals("hello", body.getString("text"))
        assertEquals(5L, body.getLong("executed_at"))
    }

    @Test
    fun `clipboardSetResponse shape`() {
        val res = clipboardSetResponse(executedAt = 7L)
        val body = JSONObject(res.body.toString(Charsets.UTF_8))
        assertTrue(body.getBoolean("ok"))
        assertEquals("clipboard", body.getString("type"))
        assertEquals("set", body.getString("op"))
        assertFalse(body.has("text"))
        assertEquals(7L, body.getLong("executed_at"))
    }

    @Test
    fun `nodeActionsCapabilityArray matches NODE_ACTION_NAMES`() {
        val arr = nodeActionsCapabilityArray()
        assertEquals(NODE_ACTION_NAMES.size, arr.length())
        for (i in NODE_ACTION_NAMES.indices) {
            assertEquals(NODE_ACTION_NAMES[i], arr.getString(i))
        }
    }
}
