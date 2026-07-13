package dev.rivet.app.data.datastore

import dev.rivet.ai.provider.Model
import dev.rivet.ai.provider.ProviderSetting
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.uuid.Uuid

class NodeChatBackendTest {

    private fun rivetBase(settings: Settings): String =
        (settings.providers.filterIsInstance<ProviderSetting.OpenAI>()
            .first { it.id == RIVET_BRIDGE_PROVIDER_ID }).baseUrl

    private fun assertActiveAndBaseConsistent(settings: Settings) {
        val expected = NodeChatBackend.chatBaseUrlForNode(settings.activeNodeDenUrl)
        assertEquals(
            "activeNodeDenUrl and Rivet baseUrl must agree",
            expected,
            rivetBase(settings),
        )
    }

    @Test
    fun `local denUrl resolves to bridge baseUrl`() {
        assertEquals(
            "http://127.0.0.1:8765/v1",
            NodeChatBackend.chatBaseUrlForNode(NodeRosterDefaults.localDenUrl()),
        )
        assertEquals(
            "http://127.0.0.1:8765/v1",
            NodeChatBackend.chatBaseUrlForNode("http://localhost:5174"),
        )
        assertEquals(
            "http://127.0.0.1:8765/v1",
            NodeChatBackend.chatBaseUrlForNode(""),
        )
    }

    @Test
    fun `remote denUrl resolves to den slash v1`() {
        assertEquals(
            "http://192.0.2.10:5174/v1",
            NodeChatBackend.chatBaseUrlForNode("http://192.0.2.10:5174"),
        )
        assertEquals(
            "http://192.0.2.10:5174/v1",
            NodeChatBackend.chatBaseUrlForNode("http://192.0.2.10:5174/"),
        )
    }

    @Test
    fun `agent health follows local bridge vs remote healthz`() {
        assertEquals(
            "http://127.0.0.1:8765/health",
            NodeChatBackend.agentHealthUrlForNode(NodeRosterDefaults.localDenUrl()),
        )
        assertEquals(
            "http://192.0.2.10:5174/healthz",
            NodeChatBackend.agentHealthUrlForNode("http://192.0.2.10:5174"),
        )
    }

    @Test
    fun `stable model ids are deterministic and preserve well-known agents`() {
        assertEquals(DEFAULT_AUTO_MODEL_ID, NodeChatBackend.stableAgentModelId("rivet-claude"))
        assertEquals(RIVET_GROK_MODEL_ID, NodeChatBackend.stableAgentModelId("rivet-grok"))
        val a = NodeChatBackend.stableAgentModelId("custom-agent")
        val b = NodeChatBackend.stableAgentModelId("custom-agent")
        assertEquals(a, b)
        assertNotEquals(DEFAULT_AUTO_MODEL_ID, a)
        assertNotEquals(RIVET_GROK_MODEL_ID, a)
    }

    @Test
    fun `isAgentSessionProvider keys off Rivet provider id only`() {
        val rivet = DEFAULT_PROVIDERS.first { it.id == RIVET_BRIDGE_PROVIDER_ID }
        assertTrue(NodeChatBackend.isAgentSessionProvider(rivet))
        val other = ProviderSetting.OpenAI(
            id = Uuid.parse("11111111-1111-4111-8111-111111111111"),
            name = "Other",
            baseUrl = "https://example.com/v1",
        )
        assertFalse(NodeChatBackend.isAgentSessionProvider(other))
        assertFalse(NodeChatBackend.isAgentSessionProvider(null))
    }

    @Test
    fun `repoint rewrites baseUrl and models without orphaning selected chat model`() = runBlocking {
        val settings = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            nodeRoster = NodeRosterDefaults.seed() + listOf(
                RosterNode(name = "phildesk", denUrl = "http://192.0.2.10:5174"),
            ),
            activeNodeDenUrl = NodeRosterDefaults.localDenUrl(),
        )

        val next = NodeChatBackend.repointProvider(
            settings = settings,
            denUrl = "http://192.0.2.10:5174",
        ) { probe ->
            assertEquals("http://192.0.2.10:5174/v1", probe.baseUrl)
            listOf(
                Model(modelId = "rivet-claude", displayName = "rivet-claude"),
                Model(modelId = "rivet-grok", displayName = "rivet-grok"),
            )
        }

        val rivet = next.providers.filterIsInstance<ProviderSetting.OpenAI>()
            .first { it.id == RIVET_BRIDGE_PROVIDER_ID }
        assertEquals("http://192.0.2.10:5174/v1", rivet.baseUrl)
        assertEquals(2, rivet.models.size)
        assertEquals(DEFAULT_AUTO_MODEL_ID, rivet.models.first { it.modelId == "rivet-claude" }.id)
        assertEquals(RIVET_GROK_MODEL_ID, rivet.models.first { it.modelId == "rivet-grok" }.id)
        // Selected model still present → kept
        assertEquals(DEFAULT_AUTO_MODEL_ID, next.chatModelId)
        assertEquals("http://192.0.2.10:5174", next.activeNodeDenUrl)
        assertActiveAndBaseConsistent(next)
    }

    @Test
    fun `repoint falls back chat model when agent missing on new node`() = runBlocking {
        val settings = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = RIVET_GROK_MODEL_ID,
            assistants = emptyList(),
        )

        val next = NodeChatBackend.repointProvider(
            settings = settings,
            denUrl = "http://192.0.2.10:5174",
        ) {
            listOf(Model(modelId = "only-claude", displayName = "only-claude"))
        }

        val rivet = next.providers.filterIsInstance<ProviderSetting.OpenAI>()
            .first { it.id == RIVET_BRIDGE_PROVIDER_ID }
        assertEquals(1, rivet.models.size)
        assertEquals(NodeChatBackend.stableAgentModelId("only-claude"), next.chatModelId)
        assertActiveAndBaseConsistent(next)
    }

    @Test
    fun `repoint rebinds secondary model ids that were Rivet agents`() = runBlocking {
        val settings = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = RIVET_GROK_MODEL_ID,
            titleModelId = RIVET_GROK_MODEL_ID,
            translateModeId = DEFAULT_AUTO_MODEL_ID,
            suggestionModelId = RIVET_GROK_MODEL_ID,
            compressModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
        )
        val foreignTitle = Uuid.parse("22222222-2222-4222-8222-222222222222")
        val withForeign = settings.copy(titleModelId = foreignTitle)

        val next = NodeChatBackend.repointProvider(
            settings = withForeign,
            denUrl = "http://192.0.2.10:5174",
        ) {
            listOf(Model(modelId = "only-claude", displayName = "only-claude"))
        }

        val onlyClaude = NodeChatBackend.stableAgentModelId("only-claude")
        // Rivet-backed secondary prefs fall back
        assertEquals(onlyClaude, next.chatModelId)
        assertEquals(onlyClaude, next.translateModeId)
        assertEquals(onlyClaude, next.suggestionModelId)
        assertEquals(onlyClaude, next.compressModelId)
        // Non-Rivet model id is left alone
        assertEquals(foreignTitle, next.titleModelId)
        assertActiveAndBaseConsistent(next)
    }

    @Test
    fun `repoint failure does not mutate caller settings object`() = runBlocking {
        val settings = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            activeNodeDenUrl = NodeRosterDefaults.localDenUrl(),
        )
        val originalBase = (settings.providers.first() as ProviderSetting.OpenAI).baseUrl

        try {
            NodeChatBackend.repointProvider(
                settings = settings,
                denUrl = "http://192.0.2.10:5174",
            ) {
                error("connection refused")
            }
            fail("expected error")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("connection refused"))
        }

        // Original object untouched; caller is responsible for not writing on failure.
        assertEquals(originalBase, (settings.providers.first() as ProviderSetting.OpenAI).baseUrl)
        assertEquals(NodeRosterDefaults.localDenUrl(), settings.activeNodeDenUrl)
    }

    @Test
    fun `repoint rejects empty model list without rewriting provider`() = runBlocking {
        val settings = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
        )
        try {
            NodeChatBackend.repointProvider(
                settings = settings,
                denUrl = "http://192.0.2.10:5174",
            ) { emptyList() }
            fail("expected error")
        } catch (e: Exception) {
            assertTrue(e.message!!.contains("no agents"))
        }
    }

    @Test
    fun `forceLocalChatBackend keeps activeNodeDenUrl and baseUrl consistent`() {
        val remote = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS.map { p ->
                if (p is ProviderSetting.OpenAI && p.id == RIVET_BRIDGE_PROVIDER_ID) {
                    p.copy(baseUrl = "http://192.0.2.10:5174/v1")
                } else {
                    p
                }
            },
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            nodeRoster = NodeRosterDefaults.seed() + listOf(
                RosterNode(name = "dead", denUrl = "http://192.0.2.10:5174"),
            ),
            activeNodeDenUrl = "http://192.0.2.10:5174",
        )

        // Simulate remove-active failure path: drop peer + force local (both fields).
        val afterRoster = remote.copy(
            nodeRoster = remote.nodeRoster.filter {
                NodeRosterDefaults.normalizeDenUrl(it.denUrl) != "http://192.0.2.10:5174"
            },
        )
        val next = NodeChatBackend.forceLocalChatBackend(afterRoster)

        assertEquals(NodeRosterDefaults.localDenUrl(), next.activeNodeDenUrl)
        assertEquals(NodeChatBackend.LOCAL_BRIDGE_BASE_URL, rivetBase(next))
        assertActiveAndBaseConsistent(next)
        // Must NOT leave UI on local while chat still points at the removed remote.
        assertFalse(rivetBase(next).contains("192.0.2.10"))
    }

    @Test
    fun `remove-active failure path is consistent unlike split write`() {
        // Document the bug we fixed: writing only activeNodeDenUrl desyncs.
        val remote = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS.map { p ->
                if (p is ProviderSetting.OpenAI && p.id == RIVET_BRIDGE_PROVIDER_ID) {
                    p.copy(baseUrl = "http://192.0.2.99:5174/v1")
                } else {
                    p
                }
            },
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            activeNodeDenUrl = "http://192.0.2.99:5174",
        )

        val buggy = remote.copy(activeNodeDenUrl = NodeRosterDefaults.localDenUrl())
        assertNotEquals(
            NodeChatBackend.chatBaseUrlForNode(buggy.activeNodeDenUrl),
            rivetBase(buggy),
        )

        val fixed = NodeChatBackend.forceLocalChatBackend(remote)
        assertActiveAndBaseConsistent(fixed)
    }

    @Test
    fun `reconcile soft-aligns baseUrl to activeNodeDenUrl on upgrade desync`() {
        val desynced = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS, // baseUrl still local bridge
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            activeNodeDenUrl = "http://192.0.2.10:5174",
        )
        assertNotEquals(
            NodeChatBackend.chatBaseUrlForNode(desynced.activeNodeDenUrl),
            rivetBase(desynced),
        )

        val fixed = NodeChatBackend.reconcileActiveNodeBaseUrl(desynced)
        assertEquals("http://192.0.2.10:5174", fixed.activeNodeDenUrl)
        assertEquals("http://192.0.2.10:5174/v1", rivetBase(fixed))
        assertActiveAndBaseConsistent(fixed)

        // Idempotent when already aligned
        assertEquals(fixed, NodeChatBackend.reconcileActiveNodeBaseUrl(fixed))
    }

    /**
     * Mirrors [NodeChatBackend.switchNode] serialization: mutex around probe+apply so the
     * last switch to enter the critical section wins for **both** activeNodeDenUrl and baseUrl.
     */
    @Test
    fun `two rapid switches converge to last one for active and baseUrl`() = runBlocking {
        val nodeA = "http://192.0.2.1:5174"
        val nodeB = "http://192.0.2.2:5174"
        val modelsA = listOf(Model(modelId = "agent-a", displayName = "A"))
        val modelsB = listOf(Model(modelId = "agent-b", displayName = "B"))

        var state = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            activeNodeDenUrl = NodeRosterDefaults.localDenUrl(),
        )
        val mutex = Mutex()

        suspend fun switchTo(den: String, models: List<Model>, probeDelayMs: Long) {
            // Acquire before probe (same as switchNode) so switches never interleave.
            mutex.withLock {
                delay(probeDelayMs)
                state = NodeChatBackend.applyRepoint(state, den, models)
            }
        }

        // B starts first but probes slower; A starts second and waits on mutex — A must win.
        val jobB = async { switchTo(nodeB, modelsB, probeDelayMs = 80) }
        delay(10) // ensure B holds the mutex first
        val jobA = async { switchTo(nodeA, modelsA, probeDelayMs = 5) }
        jobB.await()
        jobA.await()

        assertEquals(nodeA, state.activeNodeDenUrl)
        assertEquals(NodeChatBackend.chatBaseUrlForNode(nodeA), rivetBase(state))
        assertEquals(
            NodeChatBackend.stableAgentModelId("agent-a"),
            (state.providers.filterIsInstance<ProviderSetting.OpenAI>()
                .first { it.id == RIVET_BRIDGE_PROVIDER_ID }).models.single().id,
        )
        assertActiveAndBaseConsistent(state)
    }

    @Test
    fun `store-relative last-write-wins for concurrent applies`() = runBlocking {
        // Emulates SettingsStore.update { } under mutex: each writer mutates from latest.
        var state = Settings(
            init = false,
            providers = DEFAULT_PROVIDERS,
            chatModelId = DEFAULT_AUTO_MODEL_ID,
            assistants = emptyList(),
            activeNodeDenUrl = NodeRosterDefaults.localDenUrl(),
        )
        val writeMutex = Mutex()

        suspend fun apply(den: String, models: List<Model>) {
            writeMutex.withLock {
                state = NodeChatBackend.applyRepoint(state, den, models)
            }
        }

        val dens = listOf(
            "http://192.0.2.10:5174",
            "http://192.0.2.20:5174",
            "http://192.0.2.30:5174",
        )
        val jobs = dens.mapIndexed { i, den ->
            async {
                delay(i * 5L)
                apply(den, listOf(Model(modelId = "n$i", displayName = "n$i")))
            }
        }
        jobs.forEach { it.await() }

        val last = dens.last()
        assertEquals(last, state.activeNodeDenUrl)
        assertEquals(NodeChatBackend.chatBaseUrlForNode(last), rivetBase(state))
        assertActiveAndBaseConsistent(state)
    }
}
