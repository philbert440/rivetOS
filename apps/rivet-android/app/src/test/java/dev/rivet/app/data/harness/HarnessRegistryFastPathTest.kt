package dev.rivet.app.data.harness

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

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

        // Age the cache PAST the tolerance the final read will ask for, and
        // only then merge. A merge that wrongly refreshed `cachedAt` would make
        // the cache look new again and that read would be served from it — the
        // request count is what separates the two.
        delay(10)
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")),
        )
        repo.snapshot(maxAgeMs = 5)

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

    // ---- what the drawer is told to render ------------------------------------

    @Test
    fun `a switch to a node that is down blanks the drawer, it does not keep the old rows`() =
        runBlocking {
            // Every wait here is bounded. The regression this guards renders by
            // NOT emitting, so an unbounded `first()` would hang the whole
            // suite instead of failing this one test.
            val active = AtomicReference(node)
            val transport = CountingTransport { request ->
                // node-b is unreachable; node-a answers with one session.
                if (request.url.host == "node-b") throw java.io.IOException("no route")
                200 to if (request.url.encodedPath.endsWith("/sessions")) SESSIONS_ONE else REGISTRY_BODY
            }
            val repo = HarnessPlaneRepository(
                remoteDenUrl = { active.get() },
                clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
                legacyList = { _, _ -> emptyList() },
            )
            repo.snapshot(maxAgeMs = 0)
            assertEquals(listOf("aaa"), repo.rowsFor(node).firstWithin().map { it.key })

            // The drawer re-subscribes for the new node the moment the setting
            // moves — before any read for it has finished, and while the cache
            // still holds the previous machine's rows.
            assertEquals(emptyList<HarnessChatRow>(), repo.rowsFor(other).firstWithin())

            val seen = mutableListOf<List<String>>()
            val watcher = launch(Dispatchers.Unconfined) {
                repo.rowsFor(node).collect { rows -> seen += rows.map { it.key } }
            }
            active.set(other)
            repo.clear()
            // node-b never answers, so nothing but the clear can blank the list
            repo.snapshot(maxAgeMs = 0)
            watcher.cancel()

            assertEquals(listOf(listOf("aaa"), emptyList<String>()), seen)
            assertEquals(emptyList<HarnessChatRow>(), repo.rowsFor(other).firstWithin())
        }

    // ---- reads racing a node switch -------------------------------------------

    @Test
    fun `a read the node switch outran cannot strand the cache on the old node`() = runBlocking {
        val active = AtomicReference(node)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val transport = CountingTransport { request ->
            if (request.url.host == "node-a") {
                entered.countDown()
                check(release.await(10, TimeUnit.SECONDS)) { "test never released the read" }
            }
            200 to if (request.url.encodedPath.endsWith("/sessions")) SESSIONS_ONE else REGISTRY_BODY
        }
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { active.get() },
            clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
            legacyList = { _, _ -> emptyList() },
        )

        val slow = launch(Dispatchers.IO) { repo.snapshot(maxAgeMs = 0) }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        active.set(other)
        repo.clear()
        repo.snapshot(maxAgeMs = 0)
        assertEquals(other, repo.snapshots.value?.denUrl)

        release.countDown()
        slow.join()

        // Publishing the old node's answer here would leave every merge for the
        // new one refused until the next poll — the fast path dead on arrival.
        assertEquals(other, repo.snapshots.value?.denUrl)
    }

    @Test
    fun `a frame that lands mid-read is not un-painted by that read's answer`() = runBlocking {
        val block = AtomicBoolean(false)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val transport = CountingTransport { request ->
            if (block.get() && request.url.encodedPath.endsWith("/sessions")) {
                entered.countDown()
                check(release.await(10, TimeUnit.SECONDS)) { "test never released the read" }
            }
            200 to if (request.url.encodedPath.endsWith("/sessions")) SESSIONS_EMPTY else REGISTRY_BODY
        }
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { node },
            clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
            legacyList = { _, _ -> emptyList() },
        )
        repo.snapshot(maxAgeMs = 0)

        block.set(true)
        val slow = launch(Dispatchers.IO) { repo.snapshot(maxAgeMs = 0) }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        // The node created this session AFTER the read in flight had already
        // asked for the list, so that read's answer does not contain it.
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa", "pushed")),
        )
        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })
        release.countDown()
        slow.join()

        // A row the merge already painted must not blink out because a fetch
        // that predates it happened to finish second.
        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })
    }

    @Test
    fun `a cancelled read releases its accounting`() = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val transport = CountingTransport { request ->
            if (request.url.encodedPath.endsWith("/sessions")) {
                entered.countDown()
                check(release.await(10, TimeUnit.SECONDS)) { "test never released the read" }
            }
            200 to if (request.url.encodedPath.endsWith("/sessions")) SESSIONS_EMPTY else REGISTRY_BODY
        }
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { node },
            clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
            legacyList = { _, _ -> emptyList() },
        )

        // The drawer's fetch half lives under `flatMapLatest`, so this is what
        // every node switch and every poll tick does to a read in flight.
        val doomed = launch(Dispatchers.IO) { repo.snapshot(maxAgeMs = 0) }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        doomed.cancel()
        release.countDown()
        doomed.join()

        assertEquals(0, repo.bufferedFrames())
        // With the accounting leaked, `reads` never returns to zero and every
        // frame from here on is buffered for a replay that will never come.
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")),
        )
        assertEquals(0, repo.bufferedFrames())
    }

    @Test
    fun `a switch landing between the setting read and the ticket still refuses the publish`() =
        runBlocking {
            val active = AtomicReference(node)
            lateinit var repo: HarnessPlaneRepository
            var armed = true
            val transport = CountingTransport { request ->
                200 to if (request.url.encodedPath.endsWith("/sessions")) SESSIONS_ONE else REGISTRY_BODY
            }
            repo = HarnessPlaneRepository(
                // Reading the active node suspends in production (DataStore),
                // so a switch can land in the window between that read and the
                // ticket. This seam puts one exactly there.
                remoteDenUrl = {
                    val den = active.get()
                    if (armed) {
                        armed = false
                        active.set(other)
                        repo.clear()
                    }
                    den
                },
                clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
                legacyList = { _, _ -> emptyList() },
            )

            val stale = repo.snapshot(maxAgeMs = 0)

            // The answer describes a node the user has left: publishing it
            // would strand the cache there and refuse every merge for the new
            // one, and returning it would resolve rows for the wrong machine.
            assertNull(repo.snapshots.value)
            assertEquals(emptyList<HarnessChatRow>(), stale.rows)
        }

    @Test
    fun `two overlapping reads of the same node converge on the pushed row`() = runBlocking {
        // The node's own list, as it would answer a GET at that moment.
        val body = AtomicReference(SESSIONS_EMPTY)
        val blocking = AtomicBoolean(false)
        val serves = AtomicInteger(0)
        val atFirst = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val atSecond = CountDownLatch(1)
        val releaseSecond = CountDownLatch(1)
        val transport = CountingTransport { request ->
            if (!request.url.encodedPath.endsWith("/sessions")) {
                return@CountingTransport 200 to REGISTRY_BODY
            }
            val answer = body.get()
            if (blocking.get()) {
                when (serves.incrementAndGet()) {
                    1 -> {
                        atFirst.countDown()
                        check(releaseFirst.await(10, TimeUnit.SECONDS)) { "read 1 never released" }
                    }

                    2 -> {
                        atSecond.countDown()
                        check(releaseSecond.await(10, TimeUnit.SECONDS)) { "read 2 never released" }
                    }
                }
            }
            200 to answer
        }
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { node },
            clientFactory = { url, token -> HarnessControlPlaneClient(url, token, transport.client) },
            legacyList = { _, _ -> emptyList() },
        )
        // The drawer is already showing this node, so a merge has somewhere to
        // land: an empty cache is a documented no-op, not a seed.
        repo.snapshot(maxAgeMs = 0)
        blocking.set(true)

        // Read 1 asks before the session exists.
        val first = launch(Dispatchers.IO) { repo.snapshot(maxAgeMs = 0) }
        assertTrue(atFirst.await(10, TimeUnit.SECONDS))

        // The node commits the session, then broadcasts it. That order is the
        // whole reason `replay` may start at the ticket's index: any read whose
        // GET goes out after the frame already has the row in its answer.
        body.set(SESSIONS_ONE)
        repo.onRegistryEvent(
            node,
            HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa", "from the list")),
        )
        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })

        // Read 2 starts after the broadcast and publishes LAST — the ordering
        // where a replay window that skipped the frame would drop the row.
        val second = launch(Dispatchers.IO) { repo.snapshot(maxAgeMs = 0) }
        assertTrue(atSecond.await(10, TimeUnit.SECONDS))
        releaseFirst.countDown()
        first.join()
        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })
        releaseSecond.countDown()
        second.join()

        assertEquals(listOf("aaa"), repo.snapshots.value?.rows?.map { it.key })
        assertEquals(0, repo.bufferedFrames())
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
    fun `a rebind racing a node switch leaves exactly one live tail, on the new node`() =
        runBlocking {
            val gateways = mutableListOf<FakeRegistryGateway>()
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            var built = 0
            val watch = HarnessRegistryWatch(
                unconfined,
                RecordingSink(),
                gatewayFor = {
                    built += 1
                    if (built == 1) {
                        entered.complete(Unit)
                        release.await()
                    }
                    FakeRegistryGateway().also { gateways += it }
                },
                log = {},
            )

            // Hold the first attach open inside its suspension point, then let
            // a node switch and a pasted bearer both arrive behind it.
            val first = launch(Dispatchers.Unconfined) { watch.retarget(node) }
            withTimeout(10_000) { entered.await() }
            val switch = launch(Dispatchers.Unconfined) { watch.retarget(other) }
            val paste = launch(Dispatchers.Unconfined) { watch.rebind() }
            release.complete(Unit)
            listOf(first, switch, paste).joinAll()

            // Unserialized, the first attach resumes last and overwrites the
            // handles the other two built: a socket nobody can close, running
            // its backoff loop and duplicating every refresh for the lifetime
            // of the process.
            assertEquals(1, gateways.count { !it.subscription.closed })
            assertEquals(other, watch.watching)
            watch.stop()
        }

    @Test
    fun `one bad frame does not take the pump down with it`() = runBlocking {
        val sink = RecordingSink().apply { throwOnFirst = true }
        val gateway = FakeRegistryGateway()
        val logs = mutableListOf<String>()
        val watch = HarnessRegistryWatch(unconfined, sink, { gateway }, log = { logs += it })

        watch.retarget(node)
        gateway.listener!!.onEvent(HarnessEvent.SessionCreated("claude-code:aaa", summary("claude-code:aaa")))
        gateway.listener!!.onEvent(HarnessEvent.SessionUpdated("claude-code:aaa", null, HarnessStatus.ACTIVE))

        // The socket layer drops an unreadable frame without killing the
        // subscription; the pump owes the same. A dead pump would leave the
        // channel buffering forever with one log line as the only signal.
        assertEquals(2, sink.events.size)
        assertEquals(1, logs.size)
        watch.stop()
    }

    @Test
    fun `a terminal refusal leaves no tail that a retarget would mistake for live`() = runBlocking {
        val sink = RecordingSink()
        val gateways = mutableListOf<FakeRegistryGateway>()
        val watch = HarnessRegistryWatch(
            unconfined,
            sink,
            gatewayFor = { FakeRegistryGateway().also { gateways += it } },
            log = {},
        )

        watch.retarget(node)
        gateways.last().listener!!.onTerminal("this node has no harness stream (404)")
        assertNull(watch.watching)

        // Re-pointing at the same node must re-subscribe rather than
        // early-return against a stream that will never speak again.
        watch.retarget(node)

        assertEquals(2, gateways.size)
        assertEquals(node, watch.watching)
        watch.stop()
    }

    @Test
    fun `a terminal callback from a replaced socket does not defame the new tail`() = runBlocking {
        val gateways = mutableListOf<FakeRegistryGateway>()
        val watch = HarnessRegistryWatch(
            unconfined,
            RecordingSink(),
            gatewayFor = { FakeRegistryGateway().also { gateways += it } },
            log = {},
        )

        watch.retarget(node)
        val replaced = gateways.last().listener!!
        watch.rebind()

        // The refusal belongs to the socket rebind just threw away; the tail
        // that is speaking now must not be marked dead by it.
        replaced.onTerminal("not authorized for this node's harness stream (401)")

        assertEquals(2, gateways.size)
        assertEquals(node, watch.watching)
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

    /**
     * `first()` with a deadline. A render half that stops emitting is one of
     * the regressions under test, and an unbounded wait for it would hang the
     * suite rather than name the fault.
     */
    private suspend fun <T> kotlinx.coroutines.flow.Flow<T>.firstWithin(): T =
        withTimeout(5_000) { first() }

    private class RecordingSink : HarnessRegistrySink {
        val events = mutableListOf<Pair<String, HarnessEvent>>()
        var refreshes = 0

        /** Fault-isolation seam: the first frame blows up in the sink. */
        var throwOnFirst = false

        override suspend fun onRegistryEvent(denUrl: String, event: HarnessEvent): Boolean {
            events += denUrl to event
            if (throwOnFirst && events.size == 1) error("sink blew up on the first frame")
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
