package dev.rivet.app.data.harness

import dev.rivet.app.data.node.InMemoryNodeTokenStore
import dev.rivet.app.data.node.NodeAuthProbe
import dev.rivet.app.data.node.NodeAuthRegistry
import dev.rivet.app.data.node.NodeAuthState
import dev.rivet.app.ui.pages.terminal.DenHarnessClient
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The supply half of per-node bearers: what the repository reads out of the
 * credential store has to reach the real request the real client builds, on
 * both the control plane and the legacy scan it unions with. Every call is
 * answered by an OkHttp interceptor, so this asserts the header the production
 * code actually emits rather than a hand-rolled restatement of it.
 *
 * Fixture tokens are obvious placeholders; nothing here is a live credential.
 */
class HarnessPlaneTokenTest {
    private val node = "http://node-a:5174"
    private val other = "http://node-b:5174"

    private val tokens = InMemoryNodeTokenStore()
    private val auth = NodeAuthRegistry(tokens)
    private val probes = mutableListOf<NodeAuthProbe>()
    private val legacyCalls = mutableListOf<Pair<String, String?>>()

    private fun repository(
        activeNode: String,
        respond: (Request) -> Pair<Int, String> = { 200 to REGISTRY_BODY },
    ): Pair<HarnessPlaneRepository, CannedTransport> {
        val transport = CannedTransport(respond)
        val repo = HarnessPlaneRepository(
            remoteDenUrl = { activeNode },
            tokenFor = { den -> tokens.tokenFor(den) },
            onAuth = { probe ->
                probes += probe
                auth.record(probe)
            },
            clientFactory = { url, token ->
                HarnessControlPlaneClient(url, token, transport.client)
            },
            legacyList = { url, token ->
                legacyCalls += url to token
                listOf(LEGACY_ROW)
            },
        )
        return repo to transport
    }

    @Test
    fun `the stored bearer rides every control-plane request`() = runBlocking {
        tokens.put(node, "token-a")
        val (repo, transport) = repository(node)

        repo.snapshot(maxAgeMs = 0)

        assertTrue(transport.requests.isNotEmpty())
        transport.requests.forEach { req ->
            assertEquals("Bearer token-a", req.header("Authorization"))
        }
    }

    @Test
    fun `the legacy scan gets the same bearer`() = runBlocking {
        tokens.put(node, "token-a")
        val (repo, _) = repository(node)

        repo.snapshot(maxAgeMs = 0)

        assertEquals(listOf(node to "token-a"), legacyCalls)
    }

    @Test
    fun `a tokenless node sends no authorization header`() = runBlocking {
        val (repo, transport) = repository(node)

        repo.snapshot(maxAgeMs = 0)

        transport.requests.forEach { req -> assertNull(req.header("Authorization")) }
        assertEquals(listOf(node to null), legacyCalls)
    }

    @Test
    fun `each node gets its own bearer`() = runBlocking {
        tokens.put(node, "token-a")
        tokens.put(other, "token-b")

        val (repoA, transportA) = repository(node)
        repoA.snapshot(maxAgeMs = 0)
        val (repoB, transportB) = repository(other)
        repoB.snapshot(maxAgeMs = 0)

        assertEquals("Bearer token-a", transportA.requests.first().header("Authorization"))
        assertEquals("Bearer token-b", transportB.requests.first().header("Authorization"))
    }

    @Test
    fun `a 401 still degrades to legacy rows`() = runBlocking {
        val (repo, _) = repository(node) { 401 to """{"error":"unauthorized"}""" }

        val snapshot = repo.snapshot(maxAgeMs = 0)

        // Identical to a node with no control plane at all: empty descriptors,
        // legacy rows intact, every gate closed.
        assertEquals(emptyList<HarnessDescriptor>(), snapshot.descriptors)
        assertEquals(listOf(LEGACY_ROW.id), snapshot.rows.map { it.key })
        assertEquals(HarnessGate.CLOSED, snapshot.gate(LEGACY_ROW.id))
    }

    @Test
    fun `a 401 with no token asks for one`() = runBlocking {
        val (repo, _) = repository(node) { 401 to """{"error":"unauthorized"}""" }

        repo.snapshot(maxAgeMs = 0)

        assertEquals(NodeAuthState.NEEDS_TOKEN, auth.state(node))
    }

    @Test
    fun `a 401 after the bearer worked reads as a rotation`() = runBlocking {
        tokens.put(node, "token-a")
        val (ok, _) = repository(node)
        ok.snapshot(maxAgeMs = 0)
        assertEquals(NodeAuthState.OK, auth.state(node))

        val (rotated, _) = repository(node) { 401 to """{"error":"unauthorized"}""" }
        rotated.snapshot(maxAgeMs = 0)

        assertEquals(NodeAuthState.STALE_TOKEN, auth.state(node))
    }

    @Test
    fun `a node with no control plane says nothing about auth`() = runBlocking {
        val (repo, _) = repository(node) { 404 to """{"error":"not found"}""" }

        repo.snapshot(maxAgeMs = 0)

        assertEquals(NodeAuthState.UNKNOWN, auth.state(node))
        assertEquals(1, probes.size)
    }

    @Test
    fun `an unreachable node says nothing about auth`() = runBlocking {
        val (repo, _) = repository(node) { throw java.io.IOException("no route") }

        repo.snapshot(maxAgeMs = 0)

        assertEquals(NodeAuthState.UNKNOWN, auth.state(node))
    }

    private companion object {
        val LEGACY_ROW = DenHarnessClient.Session(
            id = "abc",
            command = "claude",
            title = "legacy row",
            updatedAt = 1L,
        )

        // listSessions off keeps the fixture to a single request per snapshot;
        // the union and gating rules have their own suite.
        const val REGISTRY_BODY =
            """{"harnesses":[{"harnessId":"claude-code","capabilities":{"interrupt":true}}]}"""
    }
}

/** Answers every OkHttp call in-process — no socket, no DNS, no test server. */
private class CannedTransport(private val respond: (Request) -> Pair<Int, String>) {
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
