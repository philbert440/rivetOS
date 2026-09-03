package io.rivethub.app.plane

import io.rivethub.app.gateway.MessageUsage
import io.rivethub.app.gateway.WsStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

class ChatChromeTest {
    @Test
    fun `stamp formats 07 colon 00 PM`() {
        val ts = Instant.parse("2020-01-01T19:00:00Z").toEpochMilli()
        assertEquals("07:00 PM", stamp(ts, ZoneOffset.UTC, Locale.US))
    }

    @Test
    fun `stamp of zero is null`() {
        assertNull(stamp(0L))
        assertNull(stamp(-1L))
    }

    @Test
    fun `context bar uses reported tokens and is not estimated`() {
        val view = contextBarView(50_202, "claude", listOf("hello"))
        assertNotNull(view)
        assertEquals(50_202, view!!.tokens)
        assertEquals(1_000_000, view.max)
        assertEquals(5, view.pct)
        assertFalse(view.hot)
        assertFalse(view.estimated)
        assertEquals("50.2k/1M · 5%", view.caption)
        assertEquals("5%", view.pctLabel)
    }

    @Test
    fun `context bar estimates when usage is missing`() {
        val view = contextBarView(null, "grok", listOf("abcd"))
        assertNotNull(view)
        assertTrue(view!!.estimated)
        assertEquals(5, view.tokens)
        assertEquals(500_000, view.max)
        assertTrue(view.caption.startsWith("~"))
        assertTrue(view.caption.endsWith(" est."))
    }

    @Test
    fun `context bar is hot at 85 percent`() {
        val hot = contextBarView(850_000, "claude", emptyList())
        assertNotNull(hot)
        assertEquals(85, hot!!.pct)
        assertTrue(hot.hot)
        val cool = contextBarView(840_000, "claude", emptyList())
        assertFalse(cool!!.hot)
    }

    @Test
    fun `context bar is null when there is nothing to show`() {
        assertNull(contextBarView(null, "claude", emptyList()))
        assertNull(contextBarView(0, "claude", emptyList()))
    }

    @Test
    fun `stats line includes cached prompt and completion`() {
        val line = statsLine(50_202, 5, 30_032, durationMs = null)
        assertEquals("50,202 (30,032 cached)", line.promptLabel)
        assertEquals("5", line.completionLabel)
        assertNull(line.tpsLabel)
        assertNull(line.durationLabel)
    }

    @Test
    fun `stats line omits tps and duration when they are zero`() {
        val line = statsLineOrNull(MessageUsage(promptTokens = 10, completionTokens = 4, cachedTokens = 0), 0)
        assertNotNull(line)
        assertEquals("10", line!!.promptLabel)
        assertEquals("4", line.completionLabel)
        assertNull(line.tpsLabel)
        assertNull(line.durationLabel)
    }

    @Test
    fun `stats line includes tps and duration when present`() {
        val line = statsLine(100, 50, 0, durationMs = 10_000)
        assertEquals("5.0 tok/s", line.tpsLabel)
        assertEquals("10.0s", line.durationLabel)
    }

    @Test
    fun `stats line is null without usage`() {
        assertNull(statsLineOrNull(null, 1_000))
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
    fun `picker row is compact below 380 dp`() {
        assertTrue(pickerRowCompact(379f))
        assertFalse(pickerRowCompact(380f))
        assertFalse(pickerRowCompact(412f))
    }
}
