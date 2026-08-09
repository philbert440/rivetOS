package dev.rivet.app.data.harness

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `session-created` fast path: the registry stream already carries a full
 * session summary, so the drawer must not have to re-read the list to show a
 * session that was started somewhere else.
 *
 * Kotlin twin of the merge half of
 * `apps/rivethub-web/src/lib/harness-chat.test.ts` (#478), asserted one layer
 * lower — the hub merges into a react-query cache, this merges into the plane
 * snapshot the drawer renders. Every HTTP call is answered by an interceptor,
 * so "without a refetch" is a request count rather than a claim.
 */
class HarnessRegistryFastPathTest {

    private val node = "http://node-a:5174"
    private val other = "http://node-b:5174"

    private fun summary(
        sessionId: String,
        title: String? = null,
        status: HarnessStatus = HarnessStatus.IDLE,
        updatedAt: String? = "2026-08-09T10:00:00.000Z",
    ) = HarnessSessionSummary(
        sessionId = sessionId,
        harnessId = HarnessSessionIds.parse(sessionId).harnessId,
        title = title,
        cwd = null,
        createdAt = null,
        updatedAt = updatedAt,
        status = status,
    )

    private fun repository(
        activeNode: String = node,
        sessionsBody: () -> String = { SESSIONS_EMPTY },
    ): Pair<HarnessPlaneRepository, CountingTransport> {
        val transport = CountingTransport { request ->
            when {
                request.url.encodedPath.endsWith("/sessions") -> 200 to sessionsBody()
                else -> 200 to REGISTRY_BODY
            }
        }
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { activeNode },
            clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
            legacyList = { _, _ -> emptyList() },
        )
        return repo to transport
    }

    // ---- merge, without a refetch ---------------------------------------------

    @Test
    fun `a session-created merges into the cache with no further reads`() = runBlocking {
        val (repo, transport) = repository()
        repo.snapshot(maxAgeMs = 0)
        val reads = transport.requests.size
        assertTrue(reads > 0)

        val moved = repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa", "brand new")),
        )

        assertTrue(moved)
        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })
        assertEquals(reads, transport.requests.size)
        // and the drawer's own read is served from the merge, still no traffic
        assertEquals(listOf("aaa"), repo.snapshot(maxAgeMs = 10_000).rows.map { it.key })
        assertEquals(reads, transport.requests.size)
    }

    @Test
    fun `the merged row is what a fetch of the same session would have produced`() = runBlocking {
        var body = SESSIONS_EMPTY
        val (merged, _) = repository(sessionsBody = { body })
        merged.snapshot(maxAgeMs = 0)
        // The same session the list endpoint would have answered with, carried
        // on the event instead.
        merged.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa", "from the list")),
        )

        body = SESSIONS_ONE
        val (fetched, _) = repository(sessionsBody = { body })
        fetched.snapshot(maxAgeMs = 0)

        assertEquals(fetched.snapshots.value?.rows, merged.snapshots.value?.rows)
        val row = merged.snapshots.value!!.rows.single()
        assertEquals(ChatRowKind.HARNESS, row.kind)
        assertEquals("claude-code:aaa", row.sessionId)
        // plane selection cannot tell them apart either
        assertEquals(fetched.snapshots.value!!.gate("aaa"), merged.snapshots.value!!.gate("aaa"))
        assertTrue(merged.snapshots.value!!.gate("aaa").bound)
    }

    @Test
    fun `a refetch that already carries the merged row leaves one row`() = runBlocking {
        var body = SESSIONS_EMPTY
        val (repo, _) = repository(sessionsBody = { body })
        repo.snapshot(maxAgeMs = 0)
        val created = HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa", "titled"))
        repo.onRegistryEvent(node, created)

        // the duplicate frame first: nothing moved, so nothing repaints
        val before = repo.snapshots.value
        assertFalse(repo.onRegistryEvent(node, created))
        assertSame(before, repo.snapshots.value)

        // then the reconciling read returns it too
        body = SESSIONS_ONE
        val reconciled = repo.snapshot(maxAgeMs = 0)

        assertEquals(listOf("aaa"), reconciled.rows.map { it.key })
    }

    // ---- patch in place --------------------------------------------------------

    @Test
    fun `session-updated patches the cached row in place`() = runBlocking {
        val (repo, transport) = repository(sessionsBody = { SESSIONS_ONE })
        repo.snapshot(maxAgeMs = 0)
        val reads = transport.requests.size
        assertEquals(HarnessStatus.IDLE, repo.snapshots.value?.rows?.single()?.status)

        val moved = repo.onRegistryEvent(
            node,
            HarnessEvent.SessionUpdated("claude-code:aaa", null, HarnessStatus.ACTIVE),
        )

        assertTrue(moved)
        val row = repo.snapshots.value!!.rows.single()
        assertEquals(HarnessStatus.ACTIVE, row.status)
        assertEquals("from the list", row.title) // the rest of the row is carried
        assertEquals(reads, transport.requests.size)
    }

    @Test
    fun `a rotation re-keys the cached row`() = runBlocking {
        val (repo, transport) = repository(sessionsBody = { SESSIONS_ONE })
        repo.snapshot(maxAgeMs = 0)
        val reads = transport.requests.size

        val moved = repo.onRegistryEvent(
            node,
            HarnessEvent.SessionUpdated("claude-code:bbb", "claude-code:aaa", HarnessStatus.ACTIVE),
        )

        assertTrue(moved)
        val row = repo.snapshots.value!!.rows.single()
        assertEquals("bbb", row.key)
        assertEquals("claude-code:bbb", row.sessionId)
        assertEquals("from the list", row.title)
        assertEquals(reads, transport.requests.size)
    }

    // ---- what the fast path refuses to do -------------------------------------

    @Test
    fun `an unknown session is left for the read to reconcile`() = runBlocking {
        val (repo, _) = repository(sessionsBody = { SESSIONS_ONE })
        repo.snapshot(maxAgeMs = 0)
        val before = repo.snapshots.value

        val moved = repo.onRegistryEvent(
            node,
            HarnessEvent.SessionUpdated("claude-code:zzz", null, HarnessStatus.ENDED),
        )

        assertFalse(moved)
        assertSame(before, repo.snapshots.value)
    }

    @Test
    fun `a frame from another node never writes into this one's cache`() = runBlocking {
        val (repo, _) = repository()
        repo.snapshot(maxAgeMs = 0)
        val before = repo.snapshots.value

        val moved = repo.onRegistryEvent(
            other,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")),
        )

        assertFalse(moved)
        assertSame(before, repo.snapshots.value)
    }

    @Test
    fun `nothing cached yet is a no-op, not a seed`() = runBlocking {
        val (repo, transport) = repository()

        val moved = repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")),
        )

        // A row merged before the node's capability sheet arrived would render
        // un-bound; the read that produces that sheet is already coming.
        assertFalse(moved)
        assertNull(repo.snapshots.value)
        assertTrue(transport.requests.isEmpty())
    }

    // ---- the reconciliation half stays ----------------------------------------

    @Test
    fun `a merged row the node disagrees with heals on the next read`() = runBlocking {
        val (repo, _) = repository(sessionsBody = { SESSIONS_EMPTY })
        repo.snapshot(maxAgeMs = 0)
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:ghost", summary("claude-code:ghost")),
        )
        assertEquals(listOf("ghost"), repo.snapshots.value?.rows?.map { it.key })

        val reconciled = repo.snapshot(maxAgeMs = 0)

        assertEquals(emptyList<String>(), reconciled.rows.map { it.key })
    }

    @Test
    fun `a merge does not extend the cache's life`() = runBlocking {
        val (repo, transport) = repository()
        repo.snapshot(maxAgeMs = 0)
        val reads = transport.requests.size
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")),
        )

        // A cache older than the caller's tolerance is re-read regardless of
        // the merge: the poll still runs on its own cadence, which is what
        // makes merging safe in the first place.
        delay(10)
        repo.snapshot(maxAgeMs = 1)

        assertTrue(transport.requests.size > reads)
    }

    @Test
    fun `invalidate keeps the rows on screen and clear drops them`() = runBlocking {
        val (repo, transport) = repository(sessionsBody = { SESSIONS_ONE })
        repo.snapshot(maxAgeMs = 0)
        val reads = transport.requests.size

        repo.invalidate()
        assertNotNull(repo.snapshots.value)
        repo.snapshot(maxAgeMs = 10_000)
        assertTrue(transport.requests.size > reads)

        repo.clear()
        assertNull(repo.snapshots.value)
    }

    // ---- the watch that feeds it ----------------------------------------------

    @Test
    fun `the watch forwards registry frames to the sink in order`() = runBlocking {
        val sink = RecordingSink()
        val gateway = FakeRegistryGateway()
        val watch = HarnessRegistryWatch(unconfined, sink, { gateway }, log = {})

        watch.retarget(node)
        gateway.listener!!.onEvent(HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")))
        gateway.listener!!.onEvent(HarnessEvent.SessionUpdated("claude-code:aaa", null, HarnessStatus.ACTIVE))

        assertEquals(listOf(node, node), sink.events.map { it.first })
        assertTrue(sink.events[0].second is HarnessEvent.SessionCreated)
        assertTrue(sink.events[1].second is HarnessEvent.SessionUpdated)
        watch.stop()
    }

    @Test
    fun `every open re-reads, because the tail has no replay`() = runBlocking {
        val sink = RecordingSink()
        val gateway = FakeRegistryGateway()
        val watch = HarnessRegistryWatch(unconfined, sink, { gateway }, log = {})

        watch.retarget(node)
        gateway.listener!!.onOpen()
        gateway.listener!!.onClosed()
        gateway.listener!!.onOpen()

        // First connect and reconnect alike: whatever the node published while
        // the socket was down is not coming back on the tail.
        assertEquals(2, sink.refreshes)
        watch.stop()
    }

    @Test
    fun `retargeting closes the previous node's socket`() = runBlocking {
        val sink = RecordingSink()
        val first = FakeRegistryGateway()
        val second = FakeRegistryGateway()
        val gateways = ArrayDeque(listOf(first, second))
        val watch = HarnessRegistryWatch(unconfined, sink, { gateways.removeFirst() }, log = {})

        watch.retarget(node)
        watch.retarget(other)

        assertTrue(first.subscription.closed)
        assertFalse(second.subscription.closed)
        assertEquals(other, watch.watching)

        // a frame from the socket that was already closed cannot write anything
        watch.stop()
        assertTrue(second.subscription.closed)
        assertNull(watch.watching)
    }

    @Test
    fun `the local node stops the tail entirely`() = runBlocking {
        val sink = RecordingSink()
        val gateway = FakeRegistryGateway()
        var built = 0
        val watch = HarnessRegistryWatch(
            unconfined,
            sink,
            gatewayFor = {
                built += 1
                gateway
            },
            log = {},
        )

        watch.retarget(node)
        watch.retarget(null)

        assertEquals(1, built)
        assertTrue(gateway.subscription.closed)
        assertNull(watch.watching)
    }

    @Test
    fun `a refused handshake is said once and left to the poll`() = runBlocking {
        val sink = RecordingSink()
        val gateway = FakeRegistryGateway()
        val logs = mutableListOf<String>()
        val watch = HarnessRegistryWatch(unconfined, sink, { gateway }, log = { logs += it })

        watch.retarget(node)
        // The socket has already stopped itself; a node with no registry route
        // (404) or a rejected bearer (401) is not an error state for the app.
        gateway.listener!!.onTerminal("this node has no harness stream (404)")

        assertEquals(1, logs.size)
        assertEquals(0, sink.refreshes)
        assertTrue(sink.events.isEmpty())
        watch.stop()
    }

    @Test
    fun `rebind re-opens the tail so a pasted bearer is picked up`() = runBlocking {
        val sink = RecordingSink()
        val first = FakeRegistryGateway()
        val second = FakeRegistryGateway()
        val gateways = ArrayDeque(listOf(first, second))
        val watch = HarnessRegistryWatch(unconfined, sink, { gateways.removeFirst() }, log = {})

        watch.retarget(node)
        first.listener!!.onTerminal("not authorized for this node's harness stream (401)")
        watch.rebind()

        assertTrue(first.subscription.closed)
        assertEquals(node, watch.watching)
        second.listener!!.onEvent(HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")))
        assertEquals(1, sink.events.size)
        watch.stop()
    }

    private val unconfined = CoroutineScope(Dispatchers.Unconfined)

    private class RecordingSink : HarnessRegistrySink {
        val events = mutableListOf<Pair<String, HarnessEvent>>()
        var refreshes = 0

        override suspend fun onRegistryEvent(denUrl: String, event: HarnessEvent): Boolean {
            events += denUrl to event
            return true
        }

        override suspend fun refresh() {
            refreshes += 1
        }
    }

    private class FakeRegistryGateway : HarnessRegistryGateway {
        var listener: HarnessStreamListener? = null
        val subscription = FakeSubscription()

        override fun watchHarnesses(listener: HarnessStreamListener): HarnessSubscription {
            this.listener = listener
            return subscription
        }
    }

    private class FakeSubscription : HarnessSubscription {
        var closed = false

        override fun close() {
            closed = true
        }
    }

    private companion object {
        const val REGISTRY_BODY =
            """{"harnesses":[{"harnessId":"claude-code","capabilities":{"interrupt":true,"liveStream":true,"listSessions":true}}]}"""

        const val SESSIONS_EMPTY = """{"sessions":[]}"""

        const val SESSIONS_ONE =
            """{"sessions":[{"sessionId":"claude-code:aaa","harnessId":"claude-code","title":"from the list","updatedAt":"2026-08-09T10:00:00.000Z","status":"idle"}]}"""
    }
}

/** Answers every OkHttp call in-process, and counts them. */
private class CountingTransport(private val respond: (Request) -> Pair<Int, String>) {
    val requests = mutableListOf<Request>()

    val client: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(
            Interceptor { chain ->
                val request = chain.request()
                requests += request
                val (code, body) = respond(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(code)
                    .message(if (code in 200..299) "OK" else "Error")
                    .body(body.toResponseBody("application/json".toMediaType()))
                    .build()
            },
        )
        .build()
}
