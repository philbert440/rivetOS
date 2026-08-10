package dev.rivet.app.data.datastore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * buildDenUrl / isLocalDenUrl / roster surgery (mTLS cutover + #497 follow-ups):
 * bare remote hosts default to https, loopback stays http, scheme is
 * case-insensitive, IPv6 is bracketed, and saved http:// remote rows migrate
 * to https once.
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
        assertEquals("http://[::1]:4820", NodeRosterDefaults.buildDenUrl("::1", 4820))
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
    fun schemeIsCaseInsensitive() {
        assertEquals(
            "https://192.0.2.10:5174",
            NodeRosterDefaults.buildDenUrl("HTTPS://192.0.2.10", 5174),
        )
        assertEquals(
            "http://192.0.2.10:5174",
            NodeRosterDefaults.buildDenUrl("HTTP://192.0.2.10", 5174),
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
    fun bracketedIpv6InBuildDenUrl() {
        assertEquals(
            "https://[2001:db8::1]:5174",
            NodeRosterDefaults.buildDenUrl("2001:db8::1", 5174),
        )
        assertEquals(
            "https://[2001:db8::1]:5174",
            NodeRosterDefaults.buildDenUrl("[2001:db8::1]", 5174),
        )
        assertEquals(
            "http://[::1]:5174",
            NodeRosterDefaults.buildDenUrl("http://[::1]", 5174),
        )
    }

    @Test
    fun localNodeSemanticsIncludeLocalhostAndIpv6() {
        val port = dev.rivet.app.runtime.RivetRuntime.DEN_PORT
        val local = NodeRosterDefaults.buildDenUrl("127.0.0.1", port)
        assertTrue(NodeRosterDefaults.isLocalDenUrl(local))
        assertTrue(NodeRosterDefaults.isLocalDenUrl("http://localhost:$port"))
        assertTrue(NodeRosterDefaults.isLocalDenUrl("HTTP://LOCALHOST:$port"))
        assertTrue(NodeRosterDefaults.isLocalDenUrl("http://[::1]:$port"))
        // Wrong port is not local even on loopback.
        assertFalse(NodeRosterDefaults.isLocalDenUrl("http://127.0.0.1:9"))
        // Remote is never local.
        assertFalse(NodeRosterDefaults.isLocalDenUrl("https://192.0.2.10:$port"))
    }

    @Test
    fun migrateRosterHttpsRewritesRemoteHttpOnly() {
        val local = NodeRosterDefaults.localNode()
        val roster = listOf(
            local,
            RosterNode("desk", "http://192.0.2.10:5174"),
            RosterNode("mesh", "https://ct112.mesh:5174"),
            RosterNode("loop", "http://localhost:5174"),
        )
        val next = NodeRosterDefaults.migrateRosterHttps(roster)
        assertEquals(local.denUrl, next[0].denUrl)
        assertEquals("https://192.0.2.10:5174", next[1].denUrl)
        assertEquals("desk", next[1].name)
        assertEquals("https://ct112.mesh:5174", next[2].denUrl)
        assertEquals("http://localhost:5174", next[3].denUrl)
    }

    @Test
    fun migrateRosterHttpsDedupesAfterRewrite() {
        val roster = listOf(
            RosterNode("old", "http://192.0.2.10:5174"),
            RosterNode("new", "https://192.0.2.10:5174"),
        )
        val next = NodeRosterDefaults.migrateRosterHttps(roster)
        assertEquals(1, next.size)
        assertEquals("https://192.0.2.10:5174", next[0].denUrl)
        // First wins for name.
        assertEquals("old", next[0].name)
    }

    @Test
    fun updateRosterInPlaceKeepsPositionAndAbsorbsCollision() {
        val roster = listOf(
            NodeRosterDefaults.localNode(),
            RosterNode("a", "https://192.0.2.10:5174"),
            RosterNode("b", "https://192.0.2.11:5174"),
            RosterNode("c", "https://192.0.2.12:5174"),
        )
        val next = NodeRosterDefaults.updateRosterInPlace(
            roster,
            "https://192.0.2.11:5174",
            RosterNode("b-renamed", "https://192.0.2.11:5174"),
        )
        assertNotNull(next)
        assertEquals(4, next!!.size)
        assertEquals("b-renamed", next[2].name)
        assertEquals("https://192.0.2.11:5174", next[2].denUrl)

        // Edit URL onto a row that already exists → absorb the other.
        val absorbed = NodeRosterDefaults.updateRosterInPlace(
            next,
            "https://192.0.2.10:5174",
            RosterNode("merged", "https://192.0.2.12:5174"),
        )
        assertNotNull(absorbed)
        assertEquals(3, absorbed!!.size)
        assertEquals("merged", absorbed[1].name)
        assertEquals("https://192.0.2.12:5174", absorbed[1].denUrl)
        assertTrue(absorbed.none { it.name == "c" })
    }

    @Test
    fun updateRosterInPlaceMissingOrBlankReturnsNull() {
        val roster = listOf(RosterNode("a", "https://192.0.2.10:5174"))
        assertNull(
            NodeRosterDefaults.updateRosterInPlace(
                roster,
                "https://192.0.2.99:5174",
                RosterNode("x", "https://192.0.2.10:5174"),
            ),
        )
        assertNull(
            NodeRosterDefaults.updateRosterInPlace(
                roster,
                "https://192.0.2.10:5174",
                RosterNode("  ", "https://192.0.2.10:5174"),
            ),
        )
    }

    @Test
    fun parseDenUrlRoundTrip() {
        val p = NodeRosterDefaults.parseDenUrl("https://192.0.2.10:5174")
        assertNotNull(p)
        assertEquals("https", p!!.scheme)
        assertEquals("192.0.2.10", p.host)
        assertEquals(5174, p.port)

        val v6 = NodeRosterDefaults.parseDenUrl("http://[::1]:5174")
        assertNotNull(v6)
        assertEquals("http", v6!!.scheme)
        assertEquals("[::1]", v6.host)
        assertEquals(5174, v6.port)
    }

    @Test
    fun addTimeDedupeOnNormalizedDenUrl() {
        val roster = listOf(
            RosterNode("a", "https://192.0.2.10:5174/"),
            RosterNode("b", "https://192.0.2.10:5174"),
        )
        val deduped = NodeRosterDefaults.dedupeRoster(roster)
        assertEquals(1, deduped.size)
        assertEquals("a", deduped[0].name)
    }
}
