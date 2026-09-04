package io.rivethub.app.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class OscFilterTest {
    @Test
    fun `color queries are stripped`() {
        val q = "\u001b]11;?\u0007hello".toByteArray(Charsets.ISO_8859_1)
        assertArrayEquals("hello".toByteArray(Charsets.ISO_8859_1), OscFilter.stripQueries(q))
        val st = "\u001b]10;?\u001b\\x".toByteArray(Charsets.ISO_8859_1)
        assertArrayEquals("x".toByteArray(Charsets.ISO_8859_1), OscFilter.stripQueries(st))
    }

    @Test
    fun `non-query bytes pass through`() {
        val raw = "prompt> ls\r\n".toByteArray(Charsets.UTF_8)
        val out = OscFilter.stripQueries(raw)
        assertTrue(raw === out)
        val osc = "\u001b]0;title\u0007ok".toByteArray(Charsets.ISO_8859_1)
        assertArrayEquals(osc, OscFilter.stripQueries(osc))
    }

    @Test
    fun `color reports are detected`() {
        assertTrue(OscFilter.isColorReport("\u001b]11;rgb:0d0d/1111/1717"))
        assertTrue(OscFilter.isColorReport("]10;rgb:ffff/ffff/ffff"))
        assertFalse(OscFilter.isColorReport("hello"))
        assertFalse(OscFilter.isColorReport("\u001b]52;c;AAAA"))
    }

    @Test
    fun `OSC 52 write decodes`() {
        val payload = Base64.getEncoder().encodeToString("copied".toByteArray(Charsets.UTF_8))
        assertEquals("copied", Osc52.decodeWrite("c;$payload"))
    }

    @Test
    fun `OSC 52 query is refused`() {
        assertNull(Osc52.decodeWrite("c;?"))
        assertNull(Osc52.decodeWrite("c;"))
        assertNull(Osc52.decodeWrite("no-sep"))
        assertNull(Osc52.decodeWrite("c;" + "A".repeat(Osc52.MAX_B64 + 1)))
    }
}
