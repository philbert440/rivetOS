package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextWindowTest {
    @Test
    fun `claude family defaults to the real 200k window`() {
        // Claude Code's window is 200k; mapping every claude id to 1M showed a
        // 200k session at 180k (about to compact) as 18%.
        assertEquals(200_000, contextWindowFor("claude"))
        assertEquals(200_000, contextWindowFor("claude-opus-4"))
        assertEquals(200_000, contextWindowFor("claude-sonnet-4"))
        assertEquals(200_000, contextWindowFor("anthropic"))
        assertEquals(200_000, contextWindowFor("fable"))
        assertEquals(200_000, contextWindowFor("claude-fable-5-1"))
    }

    @Test
    fun `claude 1m variant keeps the 1M window`() {
        assertEquals(1_000_000, contextWindowFor("claude-opus-4[1m]"))
        assertEquals(1_000_000, contextWindowFor("claude-sonnet-4-1m"))
        assertEquals(1_000_000, contextWindowFor("Claude-Opus-4.5[1M]"))
        assertEquals(1_000_000, contextWindowFor("fable[1m]"))
        assertEquals(1_000_000, contextWindowFor("fable-1m"))
    }

    @Test
    fun `compactAtFor reserves 35k below the window`() {
        assertEquals(35_000, COMPACT_RESERVE)
        assertEquals(165_000, compactAtFor(200_000))
        assertEquals(965_000, compactAtFor(1_000_000))
    }

    @Test
    fun `grok family is 500k`() {
        assertEquals(500_000, contextWindowFor("grok"))
        assertEquals(500_000, contextWindowFor("grok-4"))
        assertEquals(500_000, contextWindowFor("grok-fast"))
    }

    @Test
    fun `codex and gpt-5 class is 400k`() {
        assertEquals(400_000, contextWindowFor("gpt-5"))
        assertEquals(400_000, contextWindowFor("gpt-5-codex"))
        assertEquals(400_000, contextWindowFor("codex"))
        assertEquals(400_000, contextWindowFor("GPT-5.4"))
        assertEquals(128_000, contextWindowFor("gpt-4"))
        assertEquals(128_000, contextWindowFor("gpt-4o"))
    }

    @Test
    fun `local and unknown default to 262144`() {
        assertEquals(262_144, contextWindowFor("local"))
        assertEquals(262_144, contextWindowFor("local-vllm"))
        assertEquals(262_144, contextWindowFor("llama-server"))
        assertEquals(262_144, contextWindowFor("qwen2.5-27b"))
        assertEquals(262_144, contextWindowFor(null))
        assertEquals(262_144, contextWindowFor("mystery-model"))
    }

    @Test
    fun `estimatePromptTokens uses chars div 4 plus framing`() {
        assertEquals(5, estimatePromptTokens(listOf("abcd")))
        assertEquals(4 + 0 + 4 + 2, estimatePromptTokens(listOf("", "abcdefgh")))
        val one = estimatePromptTokens(listOf("hello world"))
        val two = estimatePromptTokens(listOf("hello world", "reply"))
        assertTrue(two > one)
    }
}
