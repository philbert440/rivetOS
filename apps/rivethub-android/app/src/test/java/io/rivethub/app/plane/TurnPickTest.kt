package io.rivethub.app.plane

import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors rivethub-web `lib/conversation-model-options.test.ts` (#805). */
class TurnPickTest {
    private val codex = HarnessSheet(
        turnOptions = true,
        models = listOf(
            ModelOption("a", "Model A", default = true, efforts = listOf(EffortOption("high", "High"))),
            ModelOption("b", "Model B"),
        ),
    )
    private val claude = HarnessSheet(models = listOf(ModelOption("opus", "Opus")))
    private val pick = ConversationTurnPick("codex", model = "a", effort = "high")

    private fun sheetFor(harnessId: String?): HarnessSheet? = when (harnessId) {
        "codex" -> codex
        "claude-code" -> claude
        else -> null
    }

    /** Protocol-owned, registry loaded — the web suite's default shape. */
    private fun opts(
        harnessId: String?,
        pick: ConversationTurnPick?,
        owned: Boolean? = true,
        currentModel: String? = null,
        sheet: HarnessSheet? = sheetFor(harnessId),
        registryReady: Boolean = true,
    ) = conversationModelOptions(harnessId, sheet, registryReady, pick, owned, currentModel)

    @Test
    fun `lists per-turn models and supplies the effective turn payload`() {
        val r = opts("codex", pick)
        assertEquals(listOf("a", "b"), r.models.map { it.id })
        assertEquals("a", r.effectiveModel)
        assertEquals("high", r.effectiveEffort)
        assertFalse(r.clearPick)
    }

    @Test
    fun `no picker without a turnOptions sheet or a harness`() {
        assertTrue(opts(null, null).models.isEmpty())
        assertTrue(opts("claude-code", null).models.isEmpty())
        val none = opts("codex", null, sheet = null)
        assertTrue(none.models.isEmpty())
        assertNull(none.effectiveModel)
        assertNull(none.effectiveEffort)
    }

    @Test
    fun `stale model or a pick from another harness is ignored and cleared`() {
        for (stale in listOf(pick.copy(model = "removed"), pick.copy(harnessId = "claude-code"))) {
            val r = opts("codex", stale)
            assertNull(r.effectiveModel)
            assertNull(r.effectiveEffort)
            assertTrue(r.clearPick)
        }
        // registry still loading: never clear
        assertFalse(opts("codex", pick, sheet = null, registryReady = false).clearPick)
        assertFalse(opts(null, pick).clearPick)
        // registry settled without this harness: clear
        assertTrue(opts("codex", pick, sheet = null, registryReady = true).clearPick)
    }

    @Test
    fun `harness default sends nothing and an unsupported effort is dropped`() {
        val bare = opts("codex", ConversationTurnPick("codex"))
        assertNull(bare.effectiveModel)
        assertNull(bare.effectiveEffort)
        val r = opts("codex", pick.copy(effort = "removed"))
        assertEquals("a", r.effectiveModel)
        assertNull(r.effectiveEffort)
        assertTrue(r.clearPick)
        assertEquals(ConversationTurnPick("codex", model = "a"), r.retainedPick)
        val next = opts("codex", r.retainedPick)
        assertEquals("a", next.effectiveModel)
        assertFalse(next.clearPick)
    }

    @Test
    fun `options and pick only once protocol ownership is established`() {
        assertTrue(opts("codex", null, owned = false).models.isEmpty())
        assertEquals(2, opts("codex", null, owned = true).models.size)
        val lost = opts("codex", pick, owned = false)
        assertNull(lost.effectiveModel)
        assertTrue(lost.clearPick)
        assertNull(lost.retainedPick)
    }

    @Test
    fun `unknown ownership keeps a persisted pick and sends plain text`() {
        val r = opts("codex", pick, owned = null)
        assertTrue(r.models.isEmpty())
        assertNull(r.effectiveModel)
        assertNull(r.effectiveEffort)
        assertFalse(r.clearPick)
    }

    @Test
    fun `session model drives default efforts and the default label`() {
        val r = opts("codex", ConversationTurnPick("codex", effort = "high"), currentModel = "b")
        assertTrue(r.efforts.isEmpty())
        assertNull(r.effectiveModel)
        assertNull(r.effectiveEffort)
        assertEquals("Model B", r.sessionDefaultLabel)
        assertEquals("b", r.selectedModel?.id)
        assertTrue(r.clearPick)
        assertNull(opts("codex", null).sessionDefaultLabel)
    }

    @Test
    fun `an unknown session model borrows no default-model efforts`() {
        assertTrue(opts("codex", null, currentModel = "unlisted").efforts.isEmpty())
        assertEquals("unlisted", opts("codex", null, currentModel = "unlisted").sessionDefaultLabel)
    }

    @Test
    fun `a supported effort survives a model change and an unsupported one is removed`() {
        val sheet = HarnessSheet(
            turnOptions = true,
            models = listOf(
                ModelOption("a", "A", efforts = listOf(EffortOption("high", "High"))),
                ModelOption("b", "B", efforts = listOf(EffortOption("high", "High"))),
                ModelOption("c", "C", efforts = listOf(EffortOption("low", "Low"))),
            ),
        )
        val toB = opts("codex", pick.copy(model = "b"), sheet = sheet)
        assertEquals("b", toB.effectiveModel)
        assertEquals("high", toB.effectiveEffort)
        val toC = opts("codex", pick.copy(model = "c"), sheet = sheet)
        assertEquals(ConversationTurnPick("codex", model = "c"), toC.retainedPick)
    }

    @Test
    fun `ownership is unknown until summary and registry both settle`() {
        assertNull(conversationProtocolOwnership(summaryReady = true, registryReady = false, bound = true, transport = "protocol"))
        assertNull(conversationProtocolOwnership(summaryReady = false, registryReady = true, bound = true, transport = "protocol"))
        assertEquals(true, conversationProtocolOwnership(true, true, bound = true, transport = "protocol"))
        assertEquals(false, conversationProtocolOwnership(true, true, bound = false, transport = "protocol"))
        assertEquals(false, conversationProtocolOwnership(true, true, bound = true, transport = "pty"))
    }

    @Test
    fun `turn pick round-trips through its pref encoding`() {
        assertEquals(pick, decodeTurnPick(encodeTurnPick(pick)))
        val modelOnly = ConversationTurnPick("codex", model = "a")
        assertEquals(modelOnly, decodeTurnPick(encodeTurnPick(modelOnly)))
        assertNull(decodeTurnPick(null))
        assertNull(decodeTurnPick(""))
        assertNull(decodeTurnPick("\ta\thigh"))
    }

    @Test
    fun `boot seeds the session model from the row when the summary lookup is skipped`() {
        // Row arrived with its transport: no lookup, its model is the session default.
        val seeded = bootSummaryModel(lookedUp = false, draft = false, listedModel = null, presetModel = "b")
        assertEquals("b", seeded)
        val r = opts("codex", null, currentModel = seeded)
        assertEquals("Model B", r.sessionDefaultLabel)
        assertEquals("b", r.selectedModel?.id)
        // A listed summary wins; a lookup that found nothing stays unknown.
        assertEquals("a", bootSummaryModel(lookedUp = true, draft = false, listedModel = "a", presetModel = "b"))
        assertNull(bootSummaryModel(lookedUp = true, draft = false, listedModel = null, presetModel = "b"))
        // Drafts and rows without a model have no session default.
        assertNull(bootSummaryModel(lookedUp = false, draft = true, listedModel = null, presetModel = "b"))
        assertNull(bootSummaryModel(lookedUp = false, draft = false, listedModel = null, presetModel = " "))
    }
}
