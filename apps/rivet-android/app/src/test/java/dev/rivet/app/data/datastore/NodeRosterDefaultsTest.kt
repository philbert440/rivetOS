package dev.rivet.app.data.datastore

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * buildDenUrl scheme rules (mTLS cutover): bare remote hosts default to
 * https, loopback stays http (the on-device node serves plain http), and a
 * typed scheme always wins. The pre-fix behavior forced http on everything —
 * including stripping an explicit https:// — which locked the app out of
 * every remote gateway.
 */
class NodeRosterDefaultsTest {
    @Test
    fun bareRemoteHostDefaultsToHttps() {
        assertEquals("https://192.0.2.10:5174", NodeRosterDefaults.buildDenUrl("192.0.2.10", 5174))
        assertEquals("https://ct112.mesh:5174", NodeRosterDefaults.buildDenUrl("ct112.mesh", 5174))
    }

    @Test
    fun loopbackDefaultsToHttp() {
        assertEquals("http://127.0.0.1:4820", NodeRosterDefaults.buildDenUrl("127.0.0.1", 4820))
        assertEquals("http://localhost:4820", NodeRosterDefaults.buildDenUrl("localhost", 4820))
    }

    @Test
    fun explicitSchemeWins() {
        assertEquals("http://192.0.2.10:5174", NodeRosterDefaults.buildDenUrl("http://192.0.2.10", 5174))
        assertEquals(
            "https://127.0.0.1:5174",
            NodeRosterDefaults.buildDenUrl("https://127.0.0.1", 5174),
        )
    }

    @Test
    fun trailingSlashesAndWhitespaceAreStripped() {
        assertEquals(
            "https://192.0.2.10:5174",
            NodeRosterDefaults.buildDenUrl("  https://192.0.2.10/  ", 5174),
        )
    }

    @Test
    fun localNodeSemanticsUnchanged() {
        // isLocalDenUrl keys on the http loopback form — the loopback default
        // must keep producing exactly that shape.
        val local = NodeRosterDefaults.buildDenUrl("127.0.0.1", dev.rivet.app.runtime.RivetRuntime.DEN_PORT)
        assertEquals(true, NodeRosterDefaults.isLocalDenUrl(local))
    }
}
