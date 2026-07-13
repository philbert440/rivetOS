package dev.rivet.app.data.datastore

import dev.rivet.ai.provider.Model
import dev.rivet.ai.provider.ProviderSetting
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.uuid.Uuid

class NodeChatBackendTest {

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
}
