package dev.rivet.app.data.harness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** HarnessEvent → LiveTurn fold. Twin of `harness-fold.test.ts`. */
class HarnessFoldTest {

    private val sid = "claude-code:aaa"

    private fun foldAll(vararg events: HarnessEvent): LiveTurn? {
        var turn: LiveTurn? = null
        for (event in events) turn = HarnessFold.fold(turn, event)
        return turn
    }

    @Test
    fun `assistant deltas accumulate and clear the activity line`() {
        val turn = foldAll(
            HarnessEvent.ToolUse(sid, "t1", "Bash"),
            HarnessEvent.AssistantDelta(sid, "he"),
            HarnessEvent.AssistantDelta(sid, "llo"),
        )
        assertEquals("hello", turn?.text)
        assertNull(turn?.activity)
        assertFalse(turn!!.reasoning)
    }

    @Test
    fun `tool result marks its own call by id`() {
        val turn = foldAll(
            HarnessEvent.ToolUse(sid, "t1", "Bash"),
            HarnessEvent.ToolUse(sid, "t2", "Read"),
            HarnessEvent.ToolResult(sid, "t1", "Bash", isError = false),
        )!!
        assertEquals(LiveToolEntry.Status.DONE, turn.tools.single { it.id == "t1" }.status)
        assertEquals(LiveToolEntry.Status.RUNNING, turn.tools.single { it.id == "t2" }.status)
    }

    @Test
    fun `a result whose tool-use predates the attach still shows`() {
        // At-most-once tail: attaching mid-turn loses the `tool-use` half.
        val turn = foldAll(HarnessEvent.ToolResult(sid, "t9", "Bash", isError = true))!!
        assertEquals(1, turn.tools.size)
        assertEquals(LiveToolEntry.Status.ERROR, turn.tools.single().status)
    }

    @Test
    fun `turn-complete clears the live slot`() {
        val turn = foldAll(
            HarnessEvent.AssistantDelta(sid, "hi"),
            HarnessEvent.TurnComplete(sid, "end-turn"),
        )
        assertNull(turn)
    }

    @Test
    fun `an ended or errored session clears the live turn, idle does not`() {
        val live = LiveTurn(text = "partial")
        assertNull(HarnessFold.fold(live, HarnessEvent.SessionUpdated(sid, null, HarnessStatus.ENDED)))
        assertNull(HarnessFold.fold(live, HarnessEvent.SessionUpdated(sid, null, HarnessStatus.ERROR)))
        assertEquals(
            live,
            HarnessFold.fold(live, HarnessEvent.SessionUpdated(sid, null, HarnessStatus.IDLE)),
        )
    }

    @Test
    fun `an error frame becomes the activity line, keeping the text`() {
        val turn = foldAll(
            HarnessEvent.AssistantDelta(sid, "hi"),
            HarnessEvent.Error(sid, "some_code", "it broke", true),
        )!!
        assertEquals("hi", turn.text)
        assertEquals("it broke", turn.activity)
    }

    @Test
    fun `approvals and unknown frames are not turn state`() {
        val live = LiveTurn(text = "hi")
        assertTrue(live === HarnessFold.fold(live, HarnessEvent.ApprovalRequest(sid, "r", "Bash", null)))
        assertTrue(live === HarnessFold.fold(live, HarnessEvent.Unknown(sid, "quantum-delta")))
        assertNull(HarnessFold.fold(null, HarnessEvent.Unknown(sid, "quantum-delta")))
    }

    @Test
    fun `isBusy ignores a bare placeholder`() {
        assertFalse(LiveTurn().isBusy)
        assertFalse(LiveTurn(activity = "working…").isBusy)
        assertTrue(LiveTurn(text = "x").isBusy)
        assertTrue(LiveTurn(reasoningText = "x").isBusy)
        assertTrue(LiveTurn(tools = listOf(LiveToolEntry("1", "Bash", LiveToolEntry.Status.RUNNING))).isBusy)
    }

    // ---- reasoning -----------------------------------------------------------

    @Test
    fun `real thinking appends`() {
        val turn = foldAll(
            HarnessEvent.ReasoningDelta(sid, "let me "),
            HarnessEvent.ReasoningDelta(sid, "check"),
        )!!
        assertTrue(turn.reasoning)
        assertEquals("let me check", turn.reasoningText)
    }

    @Test
    fun `an assistant delta ends the reasoning phase`() {
        val turn = foldAll(
            HarnessEvent.ReasoningDelta(sid, "hmm"),
            HarnessEvent.AssistantDelta(sid, "ok"),
        )!!
        assertFalse(turn.reasoning)
        assertEquals("hmm", turn.reasoningText)
    }

    @Test
    fun `spinner status lines replace instead of piling up`() {
        val turn = foldAll(
            HarnessEvent.ReasoningDelta(sid, "✳ Wrangling… (12s)"),
            HarnessEvent.ReasoningDelta(sid, "✳ Wrangling… (28s)"),
        )!!
        assertEquals("✳ Wrangling… (28s)", turn.reasoningText)
    }

    @Test
    fun `thinking slides through a capped window on a word boundary`() {
        val long = "word ".repeat(2000) // well past the cap
        val next = HarnessFold.nextReasoningText("", long)
        assertTrue(next.length <= HarnessFold.REASONING_TEXT_MAX)
        // Trimmed to a word boundary rather than opening mid-word.
        assertTrue(next.startsWith("word"))
        assertTrue(long.endsWith(next))
    }

    @Test
    fun `an unbounded stream never grows the live turn past the cap`() {
        var turn: LiveTurn? = null
        repeat(500) {
            turn = HarnessFold.fold(turn, HarnessEvent.ReasoningDelta(sid, "thinking hard "))
        }
        assertTrue(turn!!.reasoningText.length <= HarnessFold.REASONING_TEXT_MAX)
    }
}
