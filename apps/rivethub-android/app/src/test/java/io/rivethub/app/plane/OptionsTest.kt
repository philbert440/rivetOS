package io.rivethub.app.plane

import io.rivethub.app.gateway.EffortOption
import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals("Codex", rowPillText(null, null, "codex"))
        assertEquals("pi", rowPillText(null, null, "pi"))
    }

    @Test fun `native turn models require protocol transport and turnOptions`() {
        val sheet = HarnessSheet(
            models = listOf(
                ModelOption("gpt-5", "gpt-5", default = true, inputModalities = listOf("text", "image")),
            ),
            turnOptions = true,
            imageAttachments = true,
        )
        assertTrue(nativeTurnModels(sheet, "protocol").isNotEmpty())
        assertTrue(nativeTurnModels(sheet, "pty").isEmpty())
        assertTrue(nativeTurnModels(sheet, null).isEmpty())
        assertTrue(nativeTurnModels(sheet.copy(turnOptions = false), "protocol").isEmpty())
        assertTrue(nativeImageAttachments(sheet, "protocol"))
        assertFalse(nativeImageAttachments(sheet, "pty"))
        assertTrue(modelAcceptsImage(sheet.models!!.single()))
        assertFalse(modelAcceptsImage(ModelOption("x", "x", inputModalities = listOf("text"))))
        assertFalse(modelAcceptsImage(ModelOption("x", "x", inputModalities = null)))
        assertFalse(modelAcceptsImage(null))
        assertTrue(isNativeImageMime("image/png"))
        assertTrue(isNativeImageMime("image/jpg"))
        assertFalse(isNativeImageMime("application/pdf"))
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

    @Test fun `codex sheet is default plus low medium high xhigh`() {
        val sheet = codexSheet()
        assertEquals("default", defaultModel(sheet))
        assertEquals(listOf("low", "medium", "high", "xhigh"), effortListFor(sheet, "default").map { it.id })
        assertEquals("medium", defaultEffort(sheet, "default"))
    }

    @Test fun `spawn codex sends nothing - no modelFlag or effortFlag`() {
        assertEquals(
            SpawnFlags(),
            spawnModelEffort(codexSheet(), "codex", "default", "medium"),
        )
    }

    @Test fun `catalog drop resets native model and effort`() {
        val before = HarnessSheet(
            models = listOf(
                ModelOption(
                    "gpt-5",
                    "gpt-5",
                    default = true,
                    efforts = listOf(
                        EffortOption("low", "Low"),
                        EffortOption("high", "High", default = true),
                    ),
                ),
            ),
            turnOptions = true,
        )
        val after = HarnessSheet(
            models = listOf(
                ModelOption(
                    "codex",
                    "codex",
                    default = true,
                    efforts = listOf(EffortOption("medium", "Medium", default = true)),
                ),
            ),
            turnOptions = true,
        )
        val kept = reconcileSummaryControls(before, "protocol", "gpt-5", "high")
        assertEquals("gpt-5", kept.model)
        assertEquals("high", kept.effort)
        val reset = reconcileSummaryControls(after, "protocol", "gpt-5", "high")
        assertEquals("codex", reset.model)
        assertEquals("medium", reset.effort)
        assertEquals("protocol", reset.transport)
    }

    @Test fun `catalog drop of effort only keeps the model`() {
        val sheet = HarnessSheet(
            models = listOf(
                ModelOption(
                    "gpt-5",
                    "gpt-5",
                    default = true,
                    efforts = listOf(EffortOption("low", "Low", default = true)),
                ),
            ),
            turnOptions = true,
        )
        val next = reconcileSummaryControls(sheet, "protocol", "gpt-5", "xhigh")
        assertEquals("gpt-5", next.model)
        assertEquals("low", next.effort)
    }

    @Test fun `pty catalog swap does not rewrite model`() {
        val sheet = HarnessSheet(
            models = listOf(ModelOption("other", "other", default = true)),
            turnOptions = true,
        )
        val next = reconcileSummaryControls(sheet, "pty", "gpt-5", "high")
        assertEquals("gpt-5", next.model)
        assertEquals("high", next.effort)
    }

    @Test fun `incoming summary ids win when current is gone`() {
        val sheet = HarnessSheet(
            models = listOf(
                ModelOption(
                    "gpt-5",
                    "gpt-5",
                    default = true,
                    efforts = listOf(
                        EffortOption("low", "Low", default = true),
                        EffortOption("high", "High"),
                    ),
                ),
            ),
            turnOptions = true,
        )
        val next = reconcileSummaryControls(
            sheet,
            "pty",
            "stale",
            "gone",
            incomingTransport = "protocol",
            incomingModel = "gpt-5",
            incomingEffort = "high",
        )
        assertEquals("protocol", next.transport)
        assertEquals("gpt-5", next.model)
        assertEquals("high", next.effort)
    }
}
