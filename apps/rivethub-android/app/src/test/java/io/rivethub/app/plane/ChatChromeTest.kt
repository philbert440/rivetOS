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
        assertEquals(1_000_000, view.max)
        assertEquals(5, view.pct)
        assertFalse(view.estimated)
    }

    @Test
    fun `context bar estimates when usage is missing`() {
        val view = contextBarView(null, "grok", listOf("abcd"))
        assertNotNull(view)
        assertTrue(view!!.estimated)
        assertEquals(5, view.tokens)
        assertEquals(500_000, view.max)
        assertEquals(0, view.pct)
    }

    @Test
    fun `context bar pct rounds and caps at 100`() {
        assertEquals(85, contextBarView(850_000, "claude", emptyList())!!.pct)
        assertEquals(84, contextBarView(844_999, "claude", emptyList())!!.pct)
        assertEquals(100, contextBarView(2_000_000, "claude", emptyList())!!.pct)
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
}
