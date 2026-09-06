package io.rivethub.app.plane

import io.rivethub.app.gateway.MessageUsage
import io.rivethub.app.gateway.WsStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatChromeTest {
    @Test
    fun `context bar uses reported tokens and is not estimated`() {
        val view = contextBarView(50_202, "claude", listOf("hello"))
        assertNotNull(view)
        assertEquals(50_202, view!!.tokens)
        assertEquals(200_000, view.max)
        assertEquals(165_000, view.compactAt)
        assertEquals(30, view.pct) // 50,202 / 165,000 — toward compaction, not the window
        assertFalse(view.estimated)
        assertFalse(view.warn)
        assertFalse(view.hot)
    }

    @Test
    fun `context bar estimates when usage is missing`() {
        val view = contextBarView(null, "grok", listOf("abcd"))
        assertNotNull(view)
        assertTrue(view!!.estimated)
        assertEquals(5, view.tokens)
        assertEquals(500_000, view.max)
        assertEquals(465_000, view.compactAt)
        assertEquals(0, view.pct)
    }

    @Test
    fun `context bar pct rounds and caps at 100`() {
        assertEquals(85, contextBarView(850_000, "claude", emptyList(), contextWindow = 1_000_000, compactAt = 1_000_000)!!.pct)
        assertEquals(84, contextBarView(844_999, "claude", emptyList(), contextWindow = 1_000_000, compactAt = 1_000_000)!!.pct)
        assertEquals(100, contextBarView(2_000_000, "claude", emptyList())!!.pct)
    }

    @Test
    fun `context bar pct is tokens over compaction not the window`() {
        // The revert guard: a 200k session at 180k is about to compact — it
        // must read ~100%, never the old 18% (180k / 1M).
        val about = contextBarView(180_000, "claude", emptyList())
        assertNotNull(about)
        assertEquals(100, about!!.pct)
        assertTrue(about.hot)
        val half = contextBarView(82_500, "claude", emptyList())
        assertNotNull(half)
        assertEquals(50, half!!.pct)
        assertEquals(0.5f, half.fraction, 0.001f)
    }

    @Test
    fun `context bar prefers wire window and compactAt over the model default`() {
        val view = contextBarView(90_000, "claude", emptyList(), contextWindow = 500_000, compactAt = 450_000)
        assertNotNull(view)
        assertEquals(500_000, view!!.max)
        assertEquals(450_000, view.compactAt)
        assertEquals(20, view.pct) // not 55% (90k / the model-derived 165k)
    }

    @Test
    fun `context bar falls back to the model window when the wire fields are null`() {
        val view = contextBarView(33_000, "claude", emptyList(), contextWindow = null, compactAt = null)
        assertNotNull(view)
        assertEquals(200_000, view!!.max)
        assertEquals(165_000, view.compactAt)
        assertEquals(20, view.pct)
    }

    @Test
    fun `context bar warn and hot flags trip at 70 and 90 percent of compaction`() {
        val calm = contextBarView(60_000, "claude", emptyList(), compactAt = 100_000)!!
        assertEquals(60, calm.pct)
        assertFalse(calm.warn)
        assertFalse(calm.hot)
        val warn = contextBarView(70_000, "claude", emptyList(), compactAt = 100_000)!!
        assertEquals(70, warn.pct)
        assertTrue(warn.warn)
        assertFalse(warn.hot)
        val hot = contextBarView(90_000, "claude", emptyList(), compactAt = 100_000)!!
        assertEquals(90, hot.pct)
        assertTrue(hot.warn)
        assertTrue(hot.hot)
    }

    @Test
    fun `context bar is null when there is nothing to show`() {
        assertNull(contextBarView(null, "claude", emptyList()))
        assertNull(contextBarView(0, "claude", emptyList()))
    }

    @Test
    fun `stats line includes cached prompt and completion`() {
        val line = statsLine(50_202, 5, 30_032)
        assertEquals("50,202 (30,032 cached)", line.promptLabel)
        assertEquals("5", line.completionLabel)
    }

    @Test
    fun `stats line omits cached when it is zero`() {
        val line = statsLineOrNull(MessageUsage(promptTokens = 10, completionTokens = 4, cachedTokens = 0))
        assertNotNull(line)
        assertEquals("10", line!!.promptLabel)
        assertEquals("4", line.completionLabel)
    }

    @Test
    fun `stats line is null without usage`() {
        assertNull(statsLineOrNull(null))
    }

    @Test
    fun `composer send needs an open socket and a body`() {
        assertTrue(composerCanSend(WsStatus.OPEN, "hi", hasReadyAttachment = false))
        assertTrue(composerCanSend(WsStatus.OPEN, "  ", hasReadyAttachment = true))
        assertFalse(composerCanSend(WsStatus.OPEN, "  ", hasReadyAttachment = false))
        assertFalse(composerCanSend(WsStatus.CONNECTING, "hi", hasReadyAttachment = false))
        assertFalse(composerCanSend(WsStatus.CLOSED, "hi", hasReadyAttachment = true))
    }

    @Test
    fun `composer can queue a second message while a turn is in flight`() {
        assertTrue(composerCanSend(WsStatus.OPEN, "queued while streaming", hasReadyAttachment = false))
        assertFalse(composerShowsStop(inFlight = true, canInterrupt = false))
    }

    @Test
    fun `stop is shown only when the gate can interrupt`() {
        assertTrue(composerShowsStop(inFlight = true, canInterrupt = true))
        assertFalse(composerShowsStop(inFlight = true, canInterrupt = false))
        assertFalse(composerShowsStop(inFlight = false, canInterrupt = true))
        assertFalse(composerShowsStop(inFlight = false, canInterrupt = false))
    }

    @Test
    fun `picker row is compact below 380 dp`() {
        assertTrue(pickerRowCompact(379f))
        assertFalse(pickerRowCompact(380f))
        assertFalse(pickerRowCompact(412f))
    }

    @Test
    fun `narrow session header is menu title context segmented history in one row`() {
        // lib/session-header.ts narrowHeaderItems (chat.tsx:1645-1674)
        assertEquals(
            listOf(
                NarrowHeaderItem.Menu,
                NarrowHeaderItem.Title,
                NarrowHeaderItem.Context,
                NarrowHeaderItem.Segmented,
                NarrowHeaderItem.History,
            ),
            narrowHeaderItems(running = false, remote = false),
        )
    }

    @Test
    fun `narrow session header shows stop only while running and remote only cross-node`() {
        val items = narrowHeaderItems(running = true, remote = true)
        assertEquals(
            listOf(
                NarrowHeaderItem.Menu,
                NarrowHeaderItem.Title,
                NarrowHeaderItem.Remote,
                NarrowHeaderItem.Context,
                NarrowHeaderItem.Stop,
                NarrowHeaderItem.Segmented,
                NarrowHeaderItem.History,
            ),
            items,
        )
        assertFalse(narrowHeaderItems(running = false, remote = false).contains(NarrowHeaderItem.Stop))
        assertFalse(narrowHeaderItems(running = false, remote = false).contains(NarrowHeaderItem.Remote))
        // Stop slots between the context bar and the segmented control
        // (chat.tsx headerTail: remote · ContextBar · Stop · Terminal|Chat)
        assertTrue(items.indexOf(NarrowHeaderItem.Stop) > items.indexOf(NarrowHeaderItem.Context))
        assertTrue(items.indexOf(NarrowHeaderItem.Stop) < items.indexOf(NarrowHeaderItem.Segmented))
        assertTrue(items.indexOf(NarrowHeaderItem.Remote) < items.indexOf(NarrowHeaderItem.Context))
    }
}
