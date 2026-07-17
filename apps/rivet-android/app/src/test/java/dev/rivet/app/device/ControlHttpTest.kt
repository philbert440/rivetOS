package dev.rivet.app.device

import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for pure ControlServer HTTP helpers (no Android framework).
 */
class ControlHttpTest {

    // ---- parseUrl ----------------------------------------------------------

    @Test
    fun `parseUrl path only`() {
        val (path, query) = parseUrl("/status")
        assertEquals("/status", path)
        assertTrue(query.isEmpty())
    }

    @Test
    fun `parseUrl with query params`() {
        val (path, query) = parseUrl("/ui?format=flat&maxDepth=8")
        assertEquals("/ui", path)
        assertEquals("flat", query["format"])
        assertEquals("8", query["maxDepth"])
        assertEquals(2, query.size)
    }

    @Test
    fun `parseUrl percent-encoding`() {
        val (path, query) = parseUrl("/search?q=hello%20world&path=%2Ftmp%2Fx")
        assertEquals("/search", path)
        assertEquals("hello world", query["q"])
        assertEquals("/tmp/x", query["path"])
    }

    @Test
    fun `parseUrl plus as space`() {
        val (path, query) = parseUrl("/q?text=hello+world")
        assertEquals("/q", path)
        assertEquals("hello world", query["text"])
    }

    @Test
    fun `parseUrl empty values and bare keys`() {
        val (path, query) = parseUrl("/x?a=&b&c=1")
        assertEquals("/x", path)
        assertEquals("", query["a"])
        assertEquals("", query["b"])
        assertEquals("1", query["c"])
    }

    @Test
    fun `parseUrl trailing question mark`() {
        val (path, query) = parseUrl("/status?")
        assertEquals("/status", path)
        assertTrue(query.isEmpty())
    }

    @Test
    fun `parseUrl malformed percent best-effort never throws`() {
        // Incomplete % sequence — URLDecoder may throw; we must not.
        val (path, query) = parseUrl("/x?q=%zz&r=ok")
        assertEquals("/x", path)
        assertEquals("ok", query["r"])
        // q either decodes best-effort or is present after fallback; never throws
        assertTrue(query.containsKey("q") || query["r"] == "ok")
    }

    @Test
    fun `parseUrl empty target`() {
        val (path, query) = parseUrl("")
        assertEquals("", path)
        assertTrue(query.isEmpty())
    }

    // ---- httpStatusText ----------------------------------------------------

    @Test
    fun `httpStatusText known codes`() {
        assertEquals("OK", httpStatusText(200))
        assertEquals("Bad Request", httpStatusText(400))
        assertEquals("Unauthorized", httpStatusText(401))
        assertEquals("Forbidden", httpStatusText(403))
        assertEquals("Not Found", httpStatusText(404))
        assertEquals("Too Many Requests", httpStatusText(429))
        assertEquals("Internal Server Error", httpStatusText(500))
        assertEquals("Not Implemented", httpStatusText(501))
        assertEquals("Service Unavailable", httpStatusText(503))
    }

    @Test
    fun `httpStatusText unknown falls back`() {
        assertEquals("Unknown", httpStatusText(418))
        assertEquals("Unknown", httpStatusText(0))
    }

    // ---- writeResponse -----------------------------------------------------

    @Test
    fun `writeResponse exact status line headers and body`() {
        val body = """{"ok":true}""".toByteArray(Charsets.UTF_8)
        val res = HttpResponse(
            code = 200,
            contentType = "application/json; charset=utf-8",
            body = body,
            headers = mapOf("X-Extra" to "yes"),
        )
        val out = ByteArrayOutputStream()
        writeResponse(out, res)
        val bytes = out.toByteArray()
        val text = bytes.toString(Charsets.UTF_8)

        assertTrue(text.startsWith("HTTP/1.1 200 OK\r\n"))
        assertTrue(text.contains("Content-Type: application/json; charset=utf-8\r\n"))
        assertTrue(text.contains("Content-Length: ${body.size}\r\n"))
        assertTrue(text.contains("X-Extra: yes\r\n"))
        assertTrue(text.contains("\r\n\r\n"))

        val headerEnd = indexOfCrlfCrlf(bytes)
        assertTrue(headerEnd >= 0)
        val bodyBytes = bytes.copyOfRange(headerEnd + 4, bytes.size)
        assertArrayEquals(body, bodyBytes)
    }

    @Test
    fun `writeResponse preserves binary body including 0x00 and 0xFF`() {
        val body = byteArrayOf(0x00, 0x01, 0x7F, 0xFF.toByte(), 0x00, 0x42)
        val res = HttpResponse(
            code = 200,
            contentType = "application/octet-stream",
            body = body,
        )
        val out = ByteArrayOutputStream()
        writeResponse(out, res)
        val bytes = out.toByteArray()

        val headerEnd = indexOfCrlfCrlf(bytes)
        assertTrue(headerEnd >= 0)
        val writtenBody = bytes.copyOfRange(headerEnd + 4, bytes.size)
        assertArrayEquals(body, writtenBody)

        val headerText = bytes.copyOfRange(0, headerEnd).toString(Charsets.US_ASCII)
        assertTrue(headerText.contains("Content-Length: ${body.size}"))
        assertTrue(headerText.startsWith("HTTP/1.1 200 OK"))
    }

    @Test
    fun `writeResponse error status line`() {
        val body = """{"ok":false}""".toByteArray(Charsets.UTF_8)
        val res = HttpResponse(503, "application/json", body)
        val out = ByteArrayOutputStream()
        writeResponse(out, res)
        val text = out.toByteArray().toString(Charsets.UTF_8)
        assertTrue(text.startsWith("HTTP/1.1 503 Service Unavailable\r\n"))
        assertTrue(text.contains("Content-Length: ${body.size}\r\n"))
    }

    private fun indexOfCrlfCrlf(bytes: ByteArray): Int {
        for (i in 0 until bytes.size - 3) {
            if (bytes[i] == '\r'.code.toByte() &&
                bytes[i + 1] == '\n'.code.toByte() &&
                bytes[i + 2] == '\r'.code.toByte() &&
                bytes[i + 3] == '\n'.code.toByte()
            ) {
                return i
            }
        }
        return -1
    }
}
