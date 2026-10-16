package io.rivethub.app.data

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.HubState
import io.rivethub.app.gateway.HubStatePutResult
import io.rivethub.app.gateway.HubStateResponse
import io.rivethub.app.plane.LocalHubPrefs
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** In-memory den + prefs with the same compare-and-set rules as /api/hub/state. */
private class FakeIo(var prefs: LocalHubPrefs = LocalHubPrefs()) : HubSyncIo {
    var doc = HubStateResponse()
    var synced: HubSynced? = null
    var puts = 0
    var missingRoute = false
    /** Runs once before the next PUT is judged: another device saving first. */
    var beforePut: (() -> Unit)? = null
    /** Runs once before prefs are written back: the user editing mid-sync. */
    var beforeApply: (() -> Unit)? = null

    override suspend fun entryUrl() = "https://arctic.local:5174"
    override suspend fun nodeId() = "arctic"
    override suspend fun fetch(): HubStateResponse {
        if (missingRoute) throw GatewayException(404, "not found")
        return doc
    }
    override suspend fun put(baseVersion: Long, state: HubState): HubStatePutResult {
        puts++
        beforePut?.invoke()
        beforePut = null
        if (baseVersion != doc.version) return HubStatePutResult.Conflict(doc)
        doc = HubStateResponse(doc.version + 1, state)
        return HubStatePutResult.Saved(doc)
    }
    override suspend fun local() = prefs
    override suspend fun apply(expected: LocalHubPrefs, next: LocalHubPrefs): Boolean {
        beforeApply?.invoke()
        beforeApply = null
        if (prefs != expected) return false
        prefs = next
        return true
    }
    override suspend fun loadSynced() = synced
    override suspend fun saveSynced(synced: HubSynced) {
        this.synced = synced
    }
}

class HubStateSyncTest {
    private val nodes = mapOf("claude-code:a" to "arctic", "codex:b" to "arctic")

    @Test
    fun `first sync uploads the phone's prefs to an empty document`() = runBlocking {
        val io = FakeIo(LocalHubPrefs(names = mapOf("claude-code:a" to "Phone name"), pinned = setOf("codex:b")))
        assertEquals(HubSyncOutcome.SYNCED, syncHubStateOnce(io, nodes::get))
        assertEquals(1L, io.doc.version)
        assertEquals(mapOf("arctic::claude-code:a" to "Phone name"), io.doc.state.names)
        assertEquals(listOf("arctic::codex:b"), io.doc.state.pinned)
        assertEquals(HubSynced("arctic", 1, io.doc.state), io.synced)

        // nothing changed: the next pass does not write
        syncHubStateOnce(io, nodes::get)
        assertEquals(1, io.puts)
    }

    @Test
    fun `a desktop rename and archive land in the phone's prefs`() = runBlocking {
        val io = FakeIo()
        io.doc = HubStateResponse(
            3,
            HubState(
                projects = listOf(HubProject("p1", "General")),
                names = mapOf("arctic::claude-code:a" to "Desk name"),
                archived = listOf("arctic::codex:b"),
                modes = mapOf("arctic::claude-code:a" to "terminal"),
            ),
        )
        assertEquals(HubSyncOutcome.SYNCED, syncHubStateOnce(io, nodes::get))
        assertEquals(0, io.puts)
        assertEquals(mapOf("claude-code:a" to "Desk name"), io.prefs.names)
        assertEquals(setOf("codex:b"), io.prefs.archived)
        assertEquals(mapOf("claude-code:a" to "terminal"), io.prefs.modes)
    }

    @Test
    fun `a 409 merges onto the newer document instead of overwriting it`() = runBlocking {
        val io = FakeIo()
        syncHubStateOnce(io, nodes::get)
        io.prefs = io.prefs.copy(names = mapOf("claude-code:a" to "Phone rename"))
        io.beforePut = {
            io.doc = HubStateResponse(io.doc.version + 1, io.doc.state.copy(archived = listOf("arctic::codex:b")))
        }
        assertEquals(HubSyncOutcome.SYNCED, syncHubStateOnce(io, nodes::get))
        assertEquals(mapOf("arctic::claude-code:a" to "Phone rename"), io.doc.state.names)
        assertEquals(listOf("arctic::codex:b"), io.doc.state.archived)
        assertEquals(setOf("codex:b"), io.prefs.archived)
    }

    @Test
    fun `an edit made mid-sync is kept and asks for another pass`() = runBlocking {
        val io = FakeIo()
        io.doc = HubStateResponse(1, HubState(names = mapOf("arctic::claude-code:a" to "Desk name")))
        io.beforeApply = { io.prefs = io.prefs.copy(hidden = setOf("codex:b")) }
        assertEquals(HubSyncOutcome.RETRY, syncHubStateOnce(io, nodes::get))
        assertEquals(setOf("codex:b"), io.prefs.hidden)
        assertEquals(emptyMap<String, String>(), io.prefs.names)
    }

    @Test
    fun `a den without the route leaves the prefs alone`() = runBlocking {
        val io = FakeIo(LocalHubPrefs(names = mapOf("claude-code:a" to "Local")))
        io.missingRoute = true
        assertEquals(HubSyncOutcome.UNSUPPORTED, syncHubStateOnce(io, nodes::get))
        assertEquals(0, io.puts)
        assertNull(io.synced)
        assertEquals(mapOf("claude-code:a" to "Local"), io.prefs.names)
    }
}
