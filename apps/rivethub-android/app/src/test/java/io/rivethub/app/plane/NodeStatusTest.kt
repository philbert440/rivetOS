package io.rivethub.app.plane

import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.transport.NodeRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NodeStatusTest {
    private val entry = NodeRef(id = "entry", name = "hub", denUrl = "https://hub.example:5174", online = true)
    private val peer = NodeRef(id = "peer", name = "peer", denUrl = "https://peer.example:5174/", online = true)
    private val offPeer = peer.copy(online = false)

    private fun dots(
        entryNodeId: String? = "entry",
        nodes: List<NodeRef> = listOf(entry, peer),
        nodeErrors: Map<String, String> = emptyMap(),
        registryOpen: Boolean = true,
        activeNodeId: String? = "peer",
        chatWs: WsStatus? = null,
        discovering: Boolean = false,
        entryAnswered: Boolean? = null,
    ) = nodeDots(entryNodeId, nodes, nodeErrors, registryOpen, activeNodeId, chatWs, discovering, entryAnswered)

    @Test
    fun `label keys are agent mesh hub in order`() {
        assertEquals(listOf("agent", "mesh", "hub"), dotLabelKeys())
    }

    @Test
    fun `all healthy reads up up up`() {
        assertEquals(NodeDots(agent = Dot.Up, mesh = Dot.Up, hub = Dot.Up), dots())
    }

    // hub

    @Test
    fun `hub is down when the entry node has an error`() {
        assertEquals(Dot.Down, dots(nodeErrors = mapOf("entry" to "timeout")).hub)
        assertEquals(Dot.Down, dots(nodeErrors = mapOf("entry" to "timeout"), discovering = true).hub)
    }

    @Test
    fun `hub is unknown when the entry node is absent, and an online entry stays up while discovering`() {
        assertEquals(Dot.Up, dots(discovering = true).hub)
        assertEquals(Dot.Unknown, dots(nodes = listOf(entry.copy(online = false), peer), discovering = true).hub)
        assertEquals(Dot.Unknown, dots(nodes = listOf(peer)).hub)
        assertEquals(Dot.Unknown, dots(entryNodeId = null).hub)
        assertEquals(Dot.Unknown, dots(nodes = emptyList()).hub)
    }

    @Test
    fun `hub is down when the entry node did not answer`() {
        assertEquals(Dot.Down, dots(nodes = listOf(entry.copy(online = false), peer)).hub)
    }

    @Test
    fun `an error on another node does not touch hub`() {
        assertEquals(Dot.Up, dots(nodeErrors = mapOf("peer" to "5xx")).hub)
    }

    // mesh

    @Test
    fun `mesh is up whenever the registry socket is open`() {
        assertEquals(Dot.Up, dots(registryOpen = true).mesh)
        assertEquals(Dot.Up, dots(registryOpen = true, nodes = emptyList()).mesh)
        assertEquals(Dot.Up, dots(registryOpen = true, discovering = true).mesh)
    }

    @Test
    fun `mesh is down when nodes are known but the socket is closed`() {
        assertEquals(Dot.Down, dots(registryOpen = false).mesh)
    }

    @Test
    fun `mesh is unknown with no nodes or while discovering`() {
        assertEquals(Dot.Unknown, dots(registryOpen = false, nodes = emptyList()).mesh)
        assertEquals(Dot.Unknown, dots(registryOpen = false, discovering = true).mesh)
    }

    // agent

    @Test
    fun `agent is up with the active node online and no chat open`() {
        assertEquals(Dot.Up, dots(chatWs = null).agent)
    }

    @Test
    fun `agent is up with the active node online and the chat socket open`() {
        assertEquals(Dot.Up, dots(chatWs = WsStatus.OPEN).agent)
    }

    @Test
    fun `agent is unknown while the chat socket connects`() {
        assertEquals(Dot.Unknown, dots(chatWs = WsStatus.CONNECTING).agent)
    }

    @Test
    fun `agent is down when the chat socket is closed`() {
        assertEquals(Dot.Down, dots(chatWs = WsStatus.CLOSED).agent)
        assertEquals(Dot.Down, dots(chatWs = WsStatus.CLOSED, activeNodeId = null).agent)
    }

    @Test
    fun `agent is down when the active node has an error`() {
        assertEquals(Dot.Down, dots(nodeErrors = mapOf("peer" to "401"), chatWs = WsStatus.OPEN).agent)
    }

    @Test
    fun `agent is down when the active node is offline and discovery has settled`() {
        assertEquals(Dot.Down, dots(nodes = listOf(entry, offPeer)).agent)
        assertEquals(Dot.Unknown, dots(nodes = listOf(entry, offPeer), discovering = true).agent)
    }

    @Test
    fun `agent is unknown when the active node is absent or not chosen`() {
        assertEquals(Dot.Unknown, dots(activeNodeId = "ghost").agent)
        assertEquals(Dot.Unknown, dots(activeNodeId = null).agent)
    }

    // node resolution

    @Test
    fun `entry node matches the entry url ignoring a trailing slash and case`() {
        val nodes = listOf(peer, entry)
        assertEquals("entry", statusEntryNodeId(nodes, "https://HUB.example:5174/"))
        assertEquals("peer", statusEntryNodeId(nodes, " https://peer.example:5174 "))
        assertNull(statusEntryNodeId(nodes, ""))
        assertNull(statusEntryNodeId(nodes, "https://other.example"))
    }

    @Test
    fun `active node prefers the open chat node`() {
        val nodes = listOf(entry, peer)
        assertEquals("peer", statusActiveNodeId(nodes, "https://peer.example:5174", "entry", entry.denUrl))
        assertNull(statusActiveNodeId(nodes, "https://gone.example", "entry", entry.denUrl))
    }

    @Test
    fun `active node falls back to the view node then the entry node`() {
        val nodes = listOf(entry, peer)
        assertEquals("peer", statusActiveNodeId(nodes, null, "peer", entry.denUrl))
        assertEquals("entry", statusActiveNodeId(nodes, null, "", entry.denUrl))
        assertEquals("entry", statusActiveNodeId(nodes, null, "ghost", entry.denUrl))
        assertNull(statusActiveNodeId(emptyList(), null, "", entry.denUrl))
    }

    // fix1: the full truth table (KDoc of nodeDots, UX-SPEC §2 item 1)

    private val sockets: List<WsStatus?> = listOf(null, WsStatus.CONNECTING, WsStatus.OPEN, WsStatus.CLOSED)

    @Test
    fun `hub truth table over discovering x entry online x both sockets`() {
        // (discovering, entry online) → hub; the registry and chat sockets never move it.
        val table = mapOf(
            (false to true) to Dot.Up,
            (false to false) to Dot.Down,
            (true to true) to Dot.Up,
            (true to false) to Dot.Unknown,
        )
        for ((key, want) in table) {
            val (discovering, online) = key
            for (registryOpen in listOf(true, false)) for (ws in sockets) {
                val got = dots(
                    nodes = listOf(entry.copy(online = online), peer),
                    registryOpen = registryOpen,
                    chatWs = ws,
                    discovering = discovering,
                ).hub
                assertEquals("disc=$discovering online=$online reg=$registryOpen ws=$ws", want, got)
                // An entry error wins over every other input; a resolved entry ignores entryAnswered;
                // an unresolved entry with no discovery outcome is Unknown.
                assertEquals(
                    Dot.Down,
                    dots(
                        nodes = listOf(entry.copy(online = online), peer),
                        nodeErrors = mapOf("entry" to "x"),
                        registryOpen = registryOpen,
                        chatWs = ws,
                        discovering = discovering,
                    ).hub,
                )
                for (answered in listOf(true, false, null)) {
                    val resolved = dots(
                        nodes = listOf(entry.copy(online = online), peer),
                        registryOpen = registryOpen,
                        chatWs = ws,
                        discovering = discovering,
                        entryAnswered = answered,
                    ).hub
                    assertEquals("resolved, answered=$answered", want, resolved)
                }
                assertEquals(
                    Dot.Unknown,
                    dots(entryNodeId = null, registryOpen = registryOpen, chatWs = ws, discovering = discovering).hub,
                )
            }
        }
    }

    @Test
    fun `mesh truth table over discovering x registry socket x node state x chat socket`() {
        val rosters = mapOf(
            "none" to emptyList<NodeRef>(),
            "online" to listOf(entry, peer),
            "offline" to listOf(entry.copy(online = false), offPeer),
        )
        // (discovering, registry open, roster) → mesh; the chat socket never moves it.
        val table = mapOf(
            Triple(false, true, "none") to Dot.Up,
            Triple(false, true, "online") to Dot.Up,
            Triple(false, true, "offline") to Dot.Up,
            Triple(false, false, "none") to Dot.Unknown,
            Triple(false, false, "online") to Dot.Down,
            Triple(false, false, "offline") to Dot.Down,
            Triple(true, true, "none") to Dot.Up,
            Triple(true, true, "online") to Dot.Up,
            Triple(true, true, "offline") to Dot.Up,
            Triple(true, false, "none") to Dot.Unknown,
            Triple(true, false, "online") to Dot.Unknown,
            Triple(true, false, "offline") to Dot.Unknown,
        )
        for ((key, want) in table) {
            val (discovering, registryOpen, name) = key
            val nodes = rosters.getValue(name)
            for (ws in sockets) {
                val got = dots(nodes = nodes, registryOpen = registryOpen, chatWs = ws, discovering = discovering).mesh
                assertEquals("disc=$discovering reg=$registryOpen nodes=$name ws=$ws", want, got)
            }
        }
    }

    @Test
    fun `agent truth table over discovering x active online x chat socket`() {
        // Rows: discovering, active online, chat socket → agent.
        val table = listOf(
            Triple(false, true, null) to Dot.Up,
            Triple(false, true, WsStatus.CONNECTING) to Dot.Unknown,
            Triple(false, true, WsStatus.OPEN) to Dot.Up,
            Triple(false, true, WsStatus.CLOSED) to Dot.Down,
            Triple(false, false, null) to Dot.Down,
            Triple(false, false, WsStatus.CONNECTING) to Dot.Down,
            Triple(false, false, WsStatus.OPEN) to Dot.Down,
            Triple(false, false, WsStatus.CLOSED) to Dot.Down,
            Triple(true, true, null) to Dot.Up,
            Triple(true, true, WsStatus.CONNECTING) to Dot.Unknown,
            Triple(true, true, WsStatus.OPEN) to Dot.Up,
            Triple(true, true, WsStatus.CLOSED) to Dot.Down,
            Triple(true, false, null) to Dot.Unknown,
            Triple(true, false, WsStatus.CONNECTING) to Dot.Unknown,
            Triple(true, false, WsStatus.OPEN) to Dot.Unknown,
            Triple(true, false, WsStatus.CLOSED) to Dot.Down,
        )
        for ((key, want) in table) {
            val (discovering, online, ws) = key
            for (registryOpen in listOf(true, false)) {
                val got = dots(
                    nodes = listOf(entry, peer.copy(online = online)),
                    registryOpen = registryOpen,
                    chatWs = ws,
                    discovering = discovering,
                ).agent
                assertEquals("disc=$discovering online=$online ws=$ws reg=$registryOpen", want, got)
                // An error on the active node is Down in every row.
                assertEquals(
                    Dot.Down,
                    dots(
                        nodes = listOf(entry, peer.copy(online = online)),
                        nodeErrors = mapOf("peer" to "x"),
                        registryOpen = registryOpen,
                        chatWs = ws,
                        discovering = discovering,
                    ).agent,
                )
            }
        }
    }

    // fix1: entry resolution when the mesh does not advertise the enrolled URL verbatim

    @Test
    fun `entry node matches by host and port when scheme or path differ`() {
        val nodes = listOf(peer, entry)
        assertEquals("entry", statusEntryNodeId(nodes, "http://hub.example:5174/den"))
        assertNull(statusEntryNodeId(listOf(peer), "https://hub.example:9999"))
    }

    @Test
    fun `entry node matches a url-derived id and the hub dot reads up`() {
        val byHost = NodeRef(id = "192.0.2.110", name = "den", denUrl = "https://den.example:5174", online = true)
        val nodes = listOf(peer, byHost)
        val entryUrl = "https://192.0.2.110:5174"
        val id = statusEntryNodeId(nodes, entryUrl)
        assertEquals("192.0.2.110", id)
        assertEquals(Dot.Up, nodeDots(id, nodes, emptyMap(), true, "peer", WsStatus.OPEN, false, null).hub)
    }

    // fix2: the entry is not in its own roster — the hub dot comes from the discovery outcome

    @Test
    fun `entry never resolves to a node merely named datahub`() {
        // fix2 dropped the datahubNode step: another node's health must not paint the hub.
        val datahub = NodeRef(id = "datahub", name = "datahub", denUrl = "https://datahub.example:5174", online = false)
        val nodes = listOf(peer, datahub)
        val id = statusEntryNodeId(nodes, "https://192.0.2.110:5174")
        assertNull(id)
        // An offline "datahub" node no longer makes the hub Down; the discovery outcome decides.
        assertEquals(Dot.Up, nodeDots(id, nodes, emptyMap(), true, "peer", WsStatus.OPEN, false, true).hub)
        // The agent dot's entry fallback goes through the same resolution.
        assertNull(statusActiveNodeId(nodes, null, "", "https://192.0.2.110:5174"))
        assertNull(statusEntryNodeId(listOf(peer), "https://192.0.2.110:5174"))
    }

    @Test
    fun `hub truth table for an unresolved entry x entryAnswered`() {
        val unresolved = listOf<Pair<String, (Boolean?, Boolean, Boolean, WsStatus?) -> Dot>>(
            // entry id null (nothing matched the entry URL)
            "id null" to { a: Boolean?, d: Boolean, r: Boolean, ws: WsStatus? ->
                dots(entryNodeId = null, entryAnswered = a, discovering = d, registryOpen = r, chatWs = ws).hub
            },
            // entry id set but that node is not in the roster
            "id not listed" to { a: Boolean?, d: Boolean, r: Boolean, ws: WsStatus? ->
                dots(nodes = listOf(peer), entryAnswered = a, discovering = d, registryOpen = r, chatWs = ws).hub
            },
            // an empty roster
            "empty roster" to { a: Boolean?, d: Boolean, r: Boolean, ws: WsStatus? ->
                dots(nodes = emptyList(), entryAnswered = a, discovering = d, registryOpen = r, chatWs = ws).hub
            },
        )
        // entryAnswered → hub, whatever discovering and either socket say.
        val table = mapOf(true to Dot.Up, false to Dot.Down, null to Dot.Unknown)
        for ((name, hub) in unresolved) for ((answered, want) in table) {
            for (discovering in listOf(false, true)) for (registryOpen in listOf(true, false)) for (ws in sockets) {
                assertEquals(
                    "$name answered=$answered disc=$discovering reg=$registryOpen ws=$ws",
                    want,
                    hub(answered, discovering, registryOpen, ws),
                )
            }
        }
        // An error recorded for the (unlisted) entry id still wins.
        assertEquals(Dot.Down, dots(nodes = listOf(peer), nodeErrors = mapOf("entry" to "x"), entryAnswered = true).hub)
        // entryAnswered moves neither mesh nor agent.
        for (answered in listOf(true, false, null)) {
            assertEquals(Dot.Up, dots(entryAnswered = answered).mesh)
            assertEquals(Dot.Up, dots(entryAnswered = answered).agent)
        }
    }

    @Test
    fun `a datahub roster that does not list the datahub reads hub up once discover answered`() {
        // Shape of the device finding: the entry answered /api/mesh, but none of the listed
        // nodes has the entry's den URL, a URL-derived id, or a datahub name.
        val entryUrl = "https://hub.example:5174"
        val roster = listOf(
            NodeRef(id = "node-a", name = "node-a", denUrl = "https://node-a.example:5174", online = true),
            NodeRef(id = "node-b", name = "node-b", denUrl = "https://node-b.example:5174", online = true),
            NodeRef(id = "desk", name = "desk", denUrl = "https://198.51.100.7:5174", online = false),
        )
        val id = statusEntryNodeId(roster, entryUrl)
        assertNull(id)
        val answered = entryAnsweredFor(EntryAnswer(entryUrl, 3, true), entryUrl, 3)
        assertEquals(true, answered)
        val got = nodeDots(id, roster, emptyMap(), true, "node-a", WsStatus.OPEN, false, answered)
        assertEquals(NodeDots(agent = Dot.Up, mesh = Dot.Up, hub = Dot.Up), got)
        // The roster itself is untouched: no synthesized entry node.
        assertEquals(3, roster.size)
    }

    @Test
    fun `an empty successful roster reads hub up and a failed discover reads hub down`() {
        val url = "https://hub.example:5174"
        val ok = recordEntryAnswer(null, url, 1, answered = true, refreshGen = 4, liveRefreshGen = 4, liveIdentityGen = 1)
        assertEquals(Dot.Up, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(ok, url, 1)).hub)
        // registry closed and no nodes: mesh is not a verdict yet, but the hub answered.
        assertEquals(
            NodeDots(agent = Dot.Unknown, mesh = Dot.Unknown, hub = Dot.Up),
            dots(nodes = emptyList(), registryOpen = false, entryAnswered = entryAnsweredFor(ok, url, 1)),
        )
        val failed = recordEntryAnswer(ok, url, 1, answered = false, refreshGen = 5, liveRefreshGen = 5, liveIdentityGen = 1)
        assertEquals(Dot.Down, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(failed, url, 1)).hub)
    }

    @Test
    fun `a repeated refresh keeps the last entry outcome until the next one lands`() {
        val url = "https://hub.example:5174"
        var answer: EntryAnswer? = null
        // Nothing yet → Unknown.
        assertNull(entryAnsweredFor(answer, url, 2))
        answer = recordEntryAnswer(answer, url, 2, answered = true, refreshGen = 1, liveRefreshGen = 1, liveIdentityGen = 2)
        // Refresh #2 starts: the outcome is sticky (no flash) — same entry, trailing slash / case ignored.
        answer = entryAnswerAtRefreshStart(answer, "https://HUB.example:5174/", 2)
        assertEquals(true, entryAnsweredFor(answer, url, 2))
        assertEquals(Dot.Up, dots(nodes = emptyList(), discovering = true, entryAnswered = entryAnsweredFor(answer, url, 2)).hub)
        // Refresh #2's discover throws → Down; refresh #3 starts → still Down until it answers.
        answer = recordEntryAnswer(answer, url, 2, answered = false, refreshGen = 2, liveRefreshGen = 2, liveIdentityGen = 2)
        answer = entryAnswerAtRefreshStart(answer, url, 2)
        assertEquals(false, entryAnsweredFor(answer, url, 2))
        answer = recordEntryAnswer(answer, url, 2, answered = true, refreshGen = 3, liveRefreshGen = 3, liveIdentityGen = 2)
        assertEquals(true, entryAnsweredFor(answer, url, 2))
    }

    @Test
    fun `a new entry url or identity resets the outcome and stale results cannot write`() {
        val url = "https://hub.example:5174"
        val other = "https://other.example:5174"
        val answer = recordEntryAnswer(null, url, 2, answered = true, refreshGen = 1, liveRefreshGen = 1, liveIdentityGen = 2)
        assertNotNull(answer)
        // Entry URL changed: the read is null at once, and the next refresh start drops it.
        assertNull(entryAnsweredFor(answer, other, 2))
        assertNull(entryAnswerAtRefreshStart(answer, other, 2))
        assertEquals(Dot.Unknown, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(answer, other, 2)).hub)
        // Identity generation changed: same.
        assertNull(entryAnsweredFor(answer, url, 3))
        assertNull(entryAnswerAtRefreshStart(answer, url, 3))
        // Entry cleared.
        assertNull(entryAnsweredFor(answer, "", 2))
        assertNull(entryAnswerAtRefreshStart(answer, " ", 2))
        // A late result from a superseded refresh generation or identity leaves the record alone.
        assertEquals(
            answer,
            recordEntryAnswer(answer, url, 2, answered = false, refreshGen = 1, liveRefreshGen = 2, liveIdentityGen = 2),
        )
        assertEquals(
            answer,
            recordEntryAnswer(answer, url, 2, answered = false, refreshGen = 2, liveRefreshGen = 2, liveIdentityGen = 3),
        )
        assertNull(recordEntryAnswer(null, "", 2, answered = true, refreshGen = 1, liveRefreshGen = 1, liveIdentityGen = 2))
        // A late result for the old URL is keyed to that URL, so it never shows for the new one.
        val late = recordEntryAnswer(null, url, 2, answered = false, refreshGen = 1, liveRefreshGen = 1, liveIdentityGen = 2)
        assertNull(entryAnsweredFor(late, other, 2))
    }

    @Test
    fun `a failed discovery under identity gen N is readable at gen N`() {
        val url = "https://hub.example:5174"
        // Steady state: answered under gen 0, read clock 0.
        var st = publishEntryAnswer(
            EntryAnswerState(null, 0), url, 0, answered = true,
            refreshGen = 1, liveRefreshGen = 1, liveIdentityGen = 0,
        )
        assertEquals(EntryAnswerState(EntryAnswer(url, 0, true), 0), st)
        assertEquals(Dot.Up, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(st.answer, url, st.identityGen)).hub)
        // Settings installs a certificate: the store's generation moves to 1 with no prefs tick.
        // The next refresh starts under gen 1: the old answer is dropped and the clock moves with it.
        st = entryAnswerStateAtRefreshStart(st.answer, url, 1)
        assertEquals(EntryAnswerState(null, 1), st)
        assertEquals(Dot.Unknown, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(st.answer, url, st.identityGen)).hub)
        // That refresh's discover() throws: false is recorded under gen 1 and read at gen 1 → Down.
        st = publishEntryAnswer(st, url, 1, answered = false, refreshGen = 2, liveRefreshGen = 2, liveIdentityGen = 1)
        assertEquals(1, st.identityGen)
        assertEquals(false, entryAnsweredFor(st.answer, url, st.identityGen))
        assertEquals(Dot.Down, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(st.answer, url, st.identityGen)).hub)
        // Every later failed refresh stays Down (sticky start, then the same false again).
        st = entryAnswerStateAtRefreshStart(st.answer, url, 1)
        assertEquals(Dot.Down, dots(nodes = emptyList(), discovering = true, entryAnswered = entryAnsweredFor(st.answer, url, st.identityGen)).hub)
        st = publishEntryAnswer(st, url, 1, answered = false, refreshGen = 3, liveRefreshGen = 3, liveIdentityGen = 1)
        assertEquals(Dot.Down, dots(nodes = emptyList(), entryAnswered = entryAnsweredFor(st.answer, url, st.identityGen)).hub)
    }

    @Test
    fun `a stale entry answer publishes neither the answer nor the clock`() {
        val url = "https://hub.example:5174"
        val st = EntryAnswerState(EntryAnswer(url, 1, true), 1)
        // Superseded refresh generation.
        assertEquals(st, publishEntryAnswer(st, url, 1, answered = false, refreshGen = 4, liveRefreshGen = 5, liveIdentityGen = 1))
        // Identity moved after this refresh started: the gen-1 result must not publish (nor move the clock).
        assertEquals(st, publishEntryAnswer(st, url, 1, answered = false, refreshGen = 5, liveRefreshGen = 5, liveIdentityGen = 2))
        // A late gen-2 write while gen 3 is live: rejected, clock stays 1.
        assertEquals(st, publishEntryAnswer(st, url, 2, answered = true, refreshGen = 6, liveRefreshGen = 6, liveIdentityGen = 3))
        // Blank entry URL.
        assertEquals(st, publishEntryAnswer(st, " ", 1, answered = false, refreshGen = 5, liveRefreshGen = 5, liveIdentityGen = 1))
        // Accepted write: answer and clock agree, and match recordEntryAnswer.
        val next = publishEntryAnswer(st, url, 1, answered = false, refreshGen = 5, liveRefreshGen = 5, liveIdentityGen = 1)
        assertEquals(
            recordEntryAnswer(st.answer, url, 1, answered = false, refreshGen = 5, liveRefreshGen = 5, liveIdentityGen = 1),
            next.answer,
        )
        assertEquals(1, next.identityGen)
    }
}
