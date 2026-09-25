package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachedLinesTest {
    @Test
    fun `no attachment lines leaves the text untouched`() {
        val (body, refs) = splitAttachedLines("hello\nworld")
        assertEquals("hello\nworld", body)
        assertTrue(refs.isEmpty())
    }

    @Test
    fun `blank text is tolerated`() {
        assertEquals("" to emptyList<AttachedRef>(), splitAttachedLines(""))
        val (body, refs) = splitAttachedLines("   ")
        assertEquals("   ", body)
        assertTrue(refs.isEmpty())
    }

    @Test
    fun `one trailing line becomes one ref`() {
        val (body, refs) = splitAttachedLines("look at this\n[attached: /srv/state/uploads/a1.png]")
        assertEquals("look at this", body)
        assertEquals(1, refs.size)
        assertEquals("/srv/state/uploads/a1.png", refs[0].uri)
        assertEquals("a1.png", refs[0].name)
        assertTrue(refs[0].isImage)
    }

    @Test
    fun `several lines keep send order and mix images with files`() {
        val text = withAttachmentText("two things", listOf("/up/one.JPG", "/up/notes.pdf", "/up/three.webp"))
        val (body, refs) = splitAttachedLines(text)
        assertEquals("two things", body)
        assertEquals(listOf("one.JPG", "notes.pdf", "three.webp"), refs.map { it.name })
        assertEquals(listOf(true, false, true), refs.map { it.isImage })
    }

    @Test
    fun `attachments only yields a blank body`() {
        val (body, refs) = splitAttachedLines(withAttachmentText("", listOf("/up/a.gif", "/up/b.txt")))
        assertEquals("", body)
        assertEquals(2, refs.size)
    }

    @Test
    fun `a reference line inside the body is kept as text`() {
        val text = "see [attached: /up/x.png] above\n[attached: /up/x.png]\nmore words"
        val (body, refs) = splitAttachedLines(text)
        assertEquals(text, body)
        assertTrue(refs.isEmpty())
    }

    @Test
    fun `malformed lines stay in the body and stop the trailing run`() {
        val (body, refs) = splitAttachedLines("hi\n[attached: /up/ok.png]\n[attached: ]\n[attached: /up/last.png]")
        assertEquals("hi\n[attached: /up/ok.png]\n[attached: ]", body)
        assertEquals(listOf("/up/last.png"), refs.map { it.uri })
        val (body2, refs2) = splitAttachedLines("hi\n[attached: /up/open.png")
        assertEquals("hi\n[attached: /up/open.png", body2)
        assertTrue(refs2.isEmpty())
    }

    @Test
    fun `trailing blank lines and CRLF are tolerated`() {
        val (body, refs) = splitAttachedLines("hi\r\n[attached: /up/a.png]\r\n\n")
        assertEquals("hi", body)
        assertEquals(listOf("/up/a.png"), refs.map { it.uri })
    }

    @Test
    fun `display name is the decoded last segment without query`() {
        assertEquals("a]b.png", attachedDisplayName(sanitizeUri("/up/a]b.png")))
        assertEquals("report 1.pdf", attachedDisplayName("https://node.example/files/report%201.pdf?x=1#f"))
        assertEquals("c.txt", attachedDisplayName("C:\\tmp\\c.txt"))
        assertEquals("odd%zz", attachedDisplayName("/up/odd%zz"))
        assertEquals("/", attachedDisplayName("/"))
    }

    @Test
    fun `fetch url only for the session node`() {
        val base = "https://node.example:8443/"
        assertEquals(
            "https://node.example:8443/api/uploads/a.png",
            attachmentFetchUrl("/api/uploads/a.png", base),
        )
        assertEquals(
            "https://NODE.example:8443/x.png",
            attachmentFetchUrl("https://NODE.example:8443/x.png", base),
        )
        assertNull(attachmentFetchUrl("https://other.example:8443/x.png", base))
        assertNull(attachmentFetchUrl("https://user@node.example:8443/x.png", base))
        assertNull(attachmentFetchUrl("http://node.example:8443/x.png", base))
        assertNull(attachmentFetchUrl("/srv/state/uploads/a.png", base))
        assertNull(attachmentFetchUrl("/api/../etc/passwd", base))
        assertNull(attachmentFetchUrl("/api/uploads/a.png", ""))
        assertFalse(attachmentFetchUrl("", base) != null)
    }
}
