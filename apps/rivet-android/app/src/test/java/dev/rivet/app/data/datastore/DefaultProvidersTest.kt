package dev.rivet.app.data.datastore

import dev.rivet.ai.provider.ProviderSetting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultProvidersTest {
    @Test
    fun `default providers ship only the Rivet agent-session provider`() {
        assertEquals(1, DEFAULT_PROVIDERS.size)
        val rivet = DEFAULT_PROVIDERS.single() as ProviderSetting.OpenAI
        assertEquals(RIVET_BRIDGE_PROVIDER_ID, rivet.id)
        assertEquals(NodeChatBackend.LOCAL_BRIDGE_BASE_URL, rivet.baseUrl)
        assertTrue(rivet.builtIn)
        assertTrue(rivet.enabled)
        assertTrue(NodeChatBackend.isAgentSessionProvider(rivet))
        assertEquals(
            listOf("rivet-claude", "rivet-grok"),
            rivet.models.map { it.modelId },
        )
        assertEquals(DEFAULT_AUTO_MODEL_ID, rivet.models[0].id)
        assertEquals(RIVET_GROK_MODEL_ID, rivet.models[1].id)
    }
}
