package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessTranscriptTool
import io.rivethub.app.gateway.HarnessTranscriptTurn
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ToolSheetTest {
    private fun tool(id: String?, name: String = "Bash", status: String = "running", result: String? = null, live: Boolean = true) =
        CotStep.Tool(id, name, name, status, null, null, result, live)

    private fun stored(turns: List<HarnessTranscriptTurn>): (Int) -> List<CotStep.Tool> = { i ->
        cotSteps(turns[i], "", emptyList(), null, live = false).filterIsInstance<CotStep.Tool>()
    }

    private val noTurns = emptyList<HarnessTranscriptTurn>()

    @Test fun `a live result lands on the open sheet`() {
        val tapped = tool("a")
        val target = toolSheetTarget(LIVE_TURN_INDEX, 1, listOf(tapped), tapped)
        val next = resolveToolSheet(target, 1, listOf(tool("a", status = "done", result = "R")), noTurns, stored(noTurns))
        assertEquals(LIVE_TURN_INDEX, next.turn)
        assertEquals("R", next.shown.resultText)
        assertEquals("done", next.shown.status)
    }

    @Test fun `the sheet follows its call onto the committed turn`() {
        val target = ToolSheetTarget(LIVE_TURN_INDEX, 1, "a", 0, tool("a", status = "done", result = "R"))
        val turns = listOf(
            HarnessTranscriptTurn(role = "user", text = "q"),
            HarnessTranscriptTurn(
                role = "assistant",
                tools = listOf(HarnessTranscriptTool("Bash", status = "done", id = "a", resultText = "full result")),
            ),
        )
        val next = resolveToolSheet(target, 1, emptyList(), turns, stored(turns))
        assertEquals(1, next.turn)
        assertEquals(0, next.seq)
        assertEquals("full result", next.shown.resultText)
        assertFalse(next.shown.live)
        // stable once migrated
        assertEquals(next, resolveToolSheet(next, 2, emptyList(), turns, stored(turns)))
    }

    @Test fun `the next turn's call at the same position does not take over the sheet`() {
        val target = ToolSheetTarget(LIVE_TURN_INDEX, 1, "a", 0, tool("a", status = "done", result = "R"))
        val next = resolveToolSheet(target, 2, listOf(tool("b")), noTurns, stored(noTurns))
        assertSame(target, next)
        // id-less: same position, same name, but a newer generation
        val idless = ToolSheetTarget(LIVE_TURN_INDEX, 1, null, 0, tool(null, status = "done", result = "R"))
        assertSame(idless, resolveToolSheet(idless, 2, listOf(tool(null)), noTurns, stored(noTurns)))
        // same generation still follows the id-less call
        val same = resolveToolSheet(idless, 1, listOf(tool(null, status = "error", result = "E")), noTurns, stored(noTurns))
        assertEquals("E", same.shown.resultText)
    }

    @Test fun `a committed call without its result yet keeps the result already shown`() {
        val target = ToolSheetTarget(LIVE_TURN_INDEX, 1, "a", 0, tool("a", status = "done", result = "R"))
        val turns = listOf(HarnessTranscriptTurn(role = "assistant", tools = listOf(HarnessTranscriptTool("Bash", id = "a"))))
        val next = resolveToolSheet(target, 1, emptyList(), turns, stored(turns))
        assertEquals(0, next.turn)
        assertEquals("R", next.shown.resultText)
        assertEquals("done", next.shown.status)
    }

    @Test fun `identical calls are told apart by the tap`() {
        val first = tool(null)
        val second = tool(null)
        val steps: List<CotStep> = listOf(CotStep.Reasoning("r", null, live = true), first, second)
        assertEquals(1, toolSheetTarget(LIVE_TURN_INDEX, 1, steps, second).seq)
        assertEquals(0, toolSheetTarget(LIVE_TURN_INDEX, 1, steps, first).seq)
    }

    @Test fun `a stored call is found by id after the window shifts`() {
        val call = HarnessTranscriptTurn(role = "assistant", tools = listOf(HarnessTranscriptTool("Read", status = "done", id = "r1", resultText = "x")))
        val before = listOf(HarnessTranscriptTurn(role = "user", text = "q"), call)
        val target = ToolSheetTarget(1, 1, "r1", 0, tool("r1", name = "Read", status = "done", result = "x", live = false))
        val after = listOf(HarnessTranscriptTurn(role = "user", text = "p"), HarnessTranscriptTurn(role = "assistant", text = "a"), HarnessTranscriptTurn(role = "user", text = "q"), call)
        assertEquals(1, resolveToolSheet(target, 1, emptyList(), before, stored(before)).turn)
        assertEquals(3, resolveToolSheet(target, 1, emptyList(), after, stored(after)).turn)
    }

    private fun liveSteps(tools: List<LiveTool>): List<CotStep.Tool> =
        cotSteps(null, "", tools, null, live = true).filterIsInstance<CotStep.Tool>()

    private fun cmd(c: String) = JsonObject(mapOf("cmd" to JsonPrimitive(c)))

    @Test fun `an id-less call follows the id its result binds onto the committed turn`() {
        val running = listOf(LiveTool("Bash", cmd("ls")))
        val tapSteps = liveSteps(running)
        val target = toolSheetTarget(LIVE_TURN_INDEX, 1, tapSteps, tapSteps[0])
        assertNull(target.id)
        // the result arrives with an id the call never had; the machine binds it
        val bound = applyToolResult(running, HarnessEvent.ToolResult("s", "a", "Bash", JsonPrimitive("R")))
        assertEquals("a", bound[0].id)
        val shown = resolveToolSheet(target, 1, liveSteps(bound), noTurns, stored(noTurns))
        assertEquals("a", shown.id)
        assertEquals("R", shown.shown.resultText)
        assertEquals("done", shown.shown.status)
        // stable on the next publish, now by id
        assertEquals(shown, resolveToolSheet(shown, 1, liveSteps(bound), noTurns, stored(noTurns)))
        // the turn commits: the live slot empties and the id path finds the stored call
        val turns = listOf(
            HarnessTranscriptTurn(role = "user", text = "q"),
            HarnessTranscriptTurn(
                role = "assistant",
                tools = listOf(HarnessTranscriptTool("Bash", status = "done", id = "a", input = cmd("ls"), resultText = "full")),
            ),
        )
        val committed = resolveToolSheet(shown, 1, emptyList(), turns, stored(turns))
        assertEquals(1, committed.turn)
        assertEquals("full", committed.shown.resultText)
        assertFalse(committed.shown.live)
    }

    @Test fun `an id-less live target does not take a different call at its sequence`() {
        val tapSteps = liveSteps(listOf(LiveTool("Bash", cmd("ls"))))
        val target = toolSheetTarget(LIVE_TURN_INDEX, 1, tapSteps, tapSteps[0])
        val other = liveSteps(listOf(LiveTool("Bash", cmd("rm -r build"), status = "done", resultPreview = "gone")))
        assertSame(target, resolveToolSheet(target, 1, other, noTurns, stored(noTurns)))
    }

    @Test fun `a stored id-less call keeps its snapshot when the window shifts`() {
        fun turn(c: String, out: String) = HarnessTranscriptTurn(
            role = "assistant",
            tools = listOf(HarnessTranscriptTool("Bash", status = "done", input = cmd(c), resultText = out)),
        )
        val mine = turn("ls", "mine")
        val before = listOf(HarnessTranscriptTurn(role = "user", text = "q"), mine)
        val steps = stored(before)(1)
        val target = toolSheetTarget(1, 1, steps, steps[0])
        // unchanged transcript: the snapshot stands
        assertSame(target, resolveToolSheet(target, 1, emptyList(), before, stored(before)))
        // the window shifts: index 1 now holds another turn with a same-name id-less call
        val after = listOf(HarnessTranscriptTurn(role = "user", text = "p"), turn("pwd", "other"), HarnessTranscriptTurn(role = "user", text = "q"), mine)
        val next = resolveToolSheet(target, 1, emptyList(), after, stored(after))
        assertSame(target, next)
        assertEquals("mine", next.shown.resultText)
    }

    private fun bash(c: String, out: String?, id: String? = null) = HarnessTranscriptTurn(
        role = "assistant",
        tools = listOf(HarnessTranscriptTool("Bash", status = if (out == null) "running" else "done", id = id, input = cmd(c), resultText = out)),
    )

    @Test fun `a stored id-less call keeps its snapshot when an identical prefix and command shift in`() {
        val before = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "mine"))
        val steps = stored(before)(1)
        val target = toolSheetTarget(1, 1, steps, steps[0])
        // same preceding text, same command, different turn: content equality is not ownership
        val after = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "other"), HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "mine"))
        val next = resolveToolSheet(target, 1, emptyList(), after, stored(after))
        assertSame(target, next)
        assertEquals(1, next.turn)
        assertEquals("mine", next.shown.resultText)
    }

    @Test fun `a stored id-less call keeps its snapshot when an assistant-first window shifts`() {
        // the window starts with the tapped assistant turn: nothing precedes it
        val before = listOf(bash("ls", "mine"))
        val steps = stored(before)(0)
        val target = toolSheetTarget(0, 1, steps, steps[0])
        val after = listOf(bash("ls", "other"), HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "mine"))
        val next = resolveToolSheet(target, 1, emptyList(), after, stored(after))
        assertSame(target, next)
        assertEquals("mine", next.shown.resultText)
    }

    @Test fun `only an id refreshes a stored call whose result lands later`() {
        // id-less: the result landing on the same turn is not proof enough, the snapshot stands
        val before = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", null))
        val steps = stored(before)(1)
        val idless = toolSheetTarget(1, 1, steps, steps[0])
        val grown = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "mine"), HarnessTranscriptTurn(role = "user", text = "r"))
        val kept = resolveToolSheet(idless, 1, emptyList(), grown, stored(grown))
        assertSame(idless, kept)
        assertNull(kept.shown.resultText)
        // with an id the same growth reaches the sheet
        val withId = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", null, id = "b"))
        val idSteps = stored(withId)(1)
        val byId = toolSheetTarget(1, 1, idSteps, idSteps[0])
        val grownId = listOf(HarnessTranscriptTurn(role = "user", text = "q"), bash("ls", "mine", id = "b"), HarnessTranscriptTurn(role = "user", text = "r"))
        val landed = resolveToolSheet(byId, 1, emptyList(), grownId, stored(grownId))
        assertEquals(1, landed.turn)
        assertEquals("mine", landed.shown.resultText)
        assertEquals("done", landed.shown.status)
    }
}
