package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.parseHarnessEvent
import io.rivethub.app.gateway.wireJson
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDriverTest {
    private fun parse(json: String) = parseHarnessEvent(wireJson.parseToJsonElement(json).jsonObject)

    @Test fun `a driver frame parses holder, busy and the queue`() {
        val e = parse("""{"type":"driver","sessionId":"claude-code:x","driver":"terminal","busy":true,"queued":["one","two"]}""")
        assertEquals(HarnessEvent.Driver("claude-code:x", "terminal", true, listOf("one", "two")), e)
        val none = parse("""{"type":"driver","sessionId":"s","busy":false,"queued":[]}""") as HarnessEvent.Driver
        assertNull(none.holder)
        assertFalse(none.busy)
    }

    @Test fun `only a busy-to-idle change ends a turn the chat still shows`() {
        val busy = DriverState("terminal", busy = true)
        val idle = DriverState("terminal", busy = false)
        assertTrue(driverEndsTurn(busy, idle, inFlight = true))
        assertFalse(driverEndsTurn(busy, idle, inFlight = false))
        assertFalse(driverEndsTurn(null, idle, inFlight = true)) // a held frame before a send
        assertFalse(driverEndsTurn(idle, idle, inFlight = true))
    }

    @Test fun `the strip shows only while the terminal holds the session`() {
        assertEquals(DriverStrip.TerminalWorking, driverStrip(DriverState("terminal", busy = true)))
        assertEquals(DriverStrip.TerminalIdle, driverStrip(DriverState("terminal")))
        assertNull(driverStrip(DriverState("chat", busy = true)))
        assertNull(driverStrip(null))
    }
}
