package io.rivethub.app.plane

import io.rivethub.app.gateway.TermFrame
import io.rivethub.app.gateway.TermOwner
import io.rivethub.app.gateway.parseTermFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TermOwnerTest {
    @Test
    fun `overlay shows for a non-self owner with the device in the label`() {
        val o = ownerOverlay(TermOwner(device = "Phil's phone", self = false))
        assertTrue(o.show)
        assertEquals("This terminal is active on Phil's phone.", o.label)
    }

    @Test
    fun `overlay hides when this device owns the terminal`() {
        assertFalse(ownerOverlay(TermOwner(device = "this-laptop", self = true)).show)
    }

    @Test
    fun `overlay hides when nobody owns the terminal`() {
        assertFalse(ownerOverlay(null).show)
    }

    @Test
    fun `owner frame with a device sets the owner`() {
        val frame = parseTermFrame("""{"type":"owner","device":"phone","self":false,"since":1725460000000}""")
        assertTrue(frame is TermFrame.Owner)
        frame as TermFrame.Owner
        assertEquals("phone", frame.frame.device)
        assertFalse(frame.frame.self)
        assertEquals(1725460000000L, frame.frame.since)
        assertEquals(TermOwner(device = "phone", self = false), ownerFromFrame(frame.frame))
    }

    @Test
    fun `owner frame with device null clears the owner`() {
        val frame = parseTermFrame("""{"type":"owner","device":null,"self":false}""") as TermFrame.Owner
        assertNull(ownerFromFrame(frame.frame))
    }

    @Test
    fun `a won claim arrives as owner self true`() {
        val frame = parseTermFrame("""{"type":"owner","device":"this-laptop","self":true}""") as TermFrame.Owner
        assertEquals(TermOwner(device = "this-laptop", self = true), ownerFromFrame(frame.frame))
        assertFalse(ownerOverlay(ownerFromFrame(frame.frame)).show)
    }

    @Test
    fun `hello carries the owner`() {
        val frame = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running","owner":{"device":"phone","self":false}}""",
        ) as TermFrame.Hello
        assertEquals(TermOwner(device = "phone", self = false), frame.frame.owner)
    }

    @Test
    fun `hello without an owner parses null`() {
        val frame = parseTermFrame(
            """{"type":"hello","v":1,"id":"p1","denSession":"s","command":"claude","cols":80,"rows":24,"state":"running"}""",
        ) as TermFrame.Hello
        assertNull(frame.frame.owner)
    }

    @Test
    fun `claim frame bare and with geometry`() {
        assertEquals("""{"type":"claim"}""", termClaimJson())
        assertEquals("""{"type":"claim","cols":120,"rows":36}""", termClaimJson(120, 36))
    }
}
