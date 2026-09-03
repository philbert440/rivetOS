package io.rivethub.app.plane

import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OptionsTest {
    private val claude = HarnessSheet(
        models = listOf(
            ModelOption("fable", "Fable 5.1", default = true),
            ModelOption(
                "opus",
                "Opus 5",
                efforts = listOf(EffortOption("low", "Low"), EffortOption("max", "Max", default = true)),
            ),
        ),
        efforts = listOf(
            EffortOption("low", "Low"),
            EffortOption("medium", "Medium", default = true),
            EffortOption("high", "High"),
        ),
        modelFlag = "--model",
        effortFlag = "--effort",
    )

    private val grok = HarnessSheet(
        models = listOf(ModelOption("grok-4.6", "grok-4.6", default = true)),
        efforts = listOf(EffortOption("high", "High", default = true)),
        modelFlag = "--model",
        effortFlag = "--reasoning-effort",
    )

    private val kimi = HarnessSheet(
        models = listOf(ModelOption("k2p5", "k2p5", default = true)),
        modelFlag = "--model",
        effortFlag = null,
    )

    private val hermes = HarnessSheet(
        models = emptyList(),
        efforts = listOf(
            EffortOption("low", "Low"),
            EffortOption("medium", "Medium", default = true),
            EffortOption("high", "High"),
        ),
        modelFlag = null,
        effortFlag = "--reasoning",
    )

    @Test fun `pill prefers summary model`() {
        assertEquals("fable", rowPillText("fable", "opus", "claude-code"))
    }

    @Test fun `pill falls back to preset model`() {
        assertEquals("opus", rowPillText(null, "opus", "claude-code"))
        assertEquals("opus", rowPillText("  ", "opus", "claude-code"))
    }

    @Test fun `pill falls back to harness label`() {
        assertEquals("Claude Code", rowPillText(null, "", "claude-code"))
        assertEquals("grok Build", rowPillText(null, null, "grok-build"))
        assertEquals("Kimi Code", rowPillText(null, null, "kimi-code"))
        assertEquals("Hermes", rowPillText(null, null, "hermes"))
        assertEquals("DeepSeek", rowPillText(null, null, "deepseek-harness"))
    }

    @Test fun `unknown harness id is the label`() {
        assertEquals("unknown-harness", rowPillText(null, null, "unknown-harness"))
        assertEquals("", rowPillText(null, null, null))
    }

    @Test fun `spawn claude sheet sends model and effort`() {
        assertEquals(
            SpawnFlags(model = "fable", effort = "high"),
            spawnModelEffort(claude, "claude-code", "fable", "high"),
        )
    }

    @Test fun `spawn grok sheet uses reasoning-effort flag`() {
        assertEquals(
            SpawnFlags(model = "grok-4.6", effort = "high"),
            spawnModelEffort(grok, "grok-build", "grok-4.6", "high"),
        )
    }

    @Test fun `spawn kimi sends model only - no effortFlag`() {
        assertEquals(
            SpawnFlags(model = "k2p5", effort = null),
            spawnModelEffort(kimi, "kimi-code", "k2p5", "medium"),
        )
    }

    @Test fun `spawn hermes sends effort only - no modelFlag`() {
        assertEquals(
            SpawnFlags(model = null, effort = "high"),
            spawnModelEffort(hermes, "hermes", "ignored", "high"),
        )
    }

    @Test fun `no harnessId yields empty flags`() {
        assertEquals(SpawnFlags(), spawnModelEffort(claude, null, "fable", "high"))
        assertEquals(SpawnFlags(), spawnModelEffort(claude, "", "fable", "high"))
        assertTrue(spawnModelEffort(null, "claude-code", "fable", "high").isEmpty())
    }

    @Test fun `unknown sheet with neither flag is empty`() {
        val empty = HarnessSheet()
        assertEquals(SpawnFlags(), spawnModelEffort(empty, "deepseek-harness", "x", "y"))
    }

    @Test fun `effort off is dropped`() {
        assertEquals(
            SpawnFlags(model = "fable", effort = null),
            spawnModelEffort(claude, "claude-code", "fable", "off"),
        )
    }

    @Test fun `unlisted model is dropped even when the flag is set`() {
        assertEquals(
            SpawnFlags(model = null, effort = "high"),
            spawnModelEffort(claude, "claude-code", "not-a-model", "high"),
        )
    }

    @Test fun `unlisted effort is dropped even when the flag is set`() {
        assertEquals(
            SpawnFlags(model = "fable", effort = null),
            spawnModelEffort(claude, "claude-code", "fable", "not-an-effort"),
        )
    }

    @Test fun `defaultModel and defaultEffort follow the sheet`() {
        assertEquals("fable", defaultModel(claude))
        assertEquals("max", defaultEffort(claude, "opus"))
        assertEquals("medium", defaultEffort(claude, "fable"))
        assertEquals("", defaultModel(null))
        assertEquals("", defaultEffort(null, ""))
        assertEquals("k2p5", defaultModel(kimi))
        assertEquals("", defaultEffort(kimi, "k2p5"))
        assertEquals("medium", defaultEffort(hermes, ""))
    }
}
