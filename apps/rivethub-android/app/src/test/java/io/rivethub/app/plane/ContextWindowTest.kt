package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextWindowTest {
    @Test
    fun `claude family is 1M`() {
        assertEquals(1_000_000, contextWindowFor("claude"))
        assertEquals(1_000_000, contextWindowFor("claude-opus-4"))
        assertEquals(1_000_000, contextWindowFor("claude-sonnet-4"))
        assertEquals(1_000_000, contextWindowFor("anthropic"))
    }

    @Test
    fun `grok family is 500k`() {
        assertEquals(500_000, contextWindowFor("grok"))
        assertEquals(500_000, contextWindowFor("grok-4"))
        assertEquals(500_000, contextWindowFor("grok-fast"))
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
