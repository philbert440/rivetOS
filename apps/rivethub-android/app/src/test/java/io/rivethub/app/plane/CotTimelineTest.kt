package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTool
import io.rivethub.app.gateway.HarnessTranscriptTurn
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CotTimelineTest {
    private fun args(path: String): JsonObject = buildJsonObject { put("file_path", path) }

    private fun reasoning(n: Int) = CotStep.Reasoning("r$n", null, live = false)

    private fun steps(n: Int): List<CotStep> = (1..n).map { reasoning(it) }

    @Test fun `stored turn yields reasoning first then tools in order`() {
        val turn = HarnessTranscriptTurn(
            role = "assistant",
            text = "answer",
            thinking = "let me look",
            tools = listOf(
                HarnessTranscriptTool("Read", status = "done", args = args("/a/b/x.kt"), id = "t1", resultText = "file body"),
                HarnessTranscriptTool("Bash", status = "error", input = buildJsonObject { put("command", "ls") }),
            ),
        )
        val out = cotSteps(turn, liveReasoning = "ignored", liveTools = listOf(LiveTool("Write")), reasoningDurationMs = 3_400, live = false)
        assertEquals(3, out.size)
        assertEquals(CotStep.Reasoning("let me look", 3_400, live = false), out[0])
        val read = out[1] as CotStep.Tool
        assertEquals("t1", read.id)
        assertEquals("Read x.kt", read.title)
        assertEquals("done", read.status)
        assertEquals("file body", read.resultText)
        assertFalse(read.live)
        val bash = out[2] as CotStep.Tool
        assertEquals("Ran: ls", bash.title)
        assertNull(bash.args)
        assertEquals(buildJsonObject { put("command", "ls") }, bash.input)
    }

    @Test fun `stored turn without thinking or tools has no steps`() {
        assertTrue(cotSteps(HarnessTranscriptTurn(role = "assistant", text = "hi"), "", emptyList(), null, live = false).isEmpty())
        assertTrue(cotSteps(HarnessTranscriptTurn(role = "assistant", thinking = "  "), "", emptyList(), null, live = false).isEmpty())
        assertTrue(cotSteps(null, "", emptyList(), null, live = false).isEmpty())
    }

    @Test fun `live steps come from the live slot and ignore the turn`() {
        val stored = HarnessTranscriptTurn(role = "assistant", thinking = "stored")
        val tools = listOf(
            LiveTool("Read", args("/p/q.md"), "done", id = "c1", resultPreview = "contents"),
            LiveTool("Grep", buildJsonObject { put("pattern", "foo") }, "running", id = "c2"),
        )
        val out = cotSteps(stored, liveReasoning = "thinking hard", liveTools = tools, reasoningDurationMs = null, live = true)
        assertEquals(3, out.size)
        assertEquals(CotStep.Reasoning("thinking hard", null, live = true), out[0])
        val read = out[1] as CotStep.Tool
        assertEquals("Read q.md", read.title)
        assertEquals("contents", read.resultText)
        assertEquals("c1", read.id)
        assertTrue(read.live)
        val grep = out[2] as CotStep.Tool
        assertEquals("Searched: foo", grep.title)
        assertEquals("running", grep.status)
        assertNull(grep.resultText)
    }

    @Test fun `live without reasoning starts at the first tool`() {
        val out = cotSteps(null, "", listOf(LiveTool("Bash")), null, live = true)
        assertEquals(1, out.size)
        assertTrue(out[0] is CotStep.Tool)
    }

    @Test fun `fold keeps the last two steps and counts the rest`() {
        assertEquals(CotFold(emptyList(), 0), foldSteps(steps(0), expanded = false))
        assertEquals(CotFold(steps(1), 0), foldSteps(steps(1), expanded = false))
        assertEquals(CotFold(steps(2), 0), foldSteps(steps(2), expanded = false))
        val five = steps(5)
        val folded = foldSteps(five, expanded = false)
        assertEquals(listOf(reasoning(4), reasoning(5)), folded.visible)
        assertEquals(3, folded.hiddenCount)
    }

    @Test fun `expanded fold shows everything and hides nothing`() {
        val five = steps(5)
        assertEquals(CotFold(five, 0), foldSteps(five, expanded = true))
        assertEquals(CotFold(steps(1), 0), foldSteps(steps(1), expanded = true))
    }

    @Test fun `keepLast is honoured`() {
        val f = foldSteps(steps(5), expanded = false, keepLast = 3)
        assertEquals(3, f.visible.size)
        assertEquals(2, f.hiddenCount)
    }

    @Test fun `collapse shows only when expanded with something to fold`() {
        assertTrue(showCollapse(5, expanded = true))
        assertFalse(showCollapse(5, expanded = false))
        assertFalse(showCollapse(2, expanded = true))
        assertTrue(showCollapse(3, expanded = true))
    }

    @Test fun `dot colour keys map status to tokens`() {
        assertEquals("em", stepDotColorKey("running"))
        assertEquals("red", stepDotColorKey("error"))
        assertEquals("inkDim", stepDotColorKey("done"))
        assertEquals("inkDim", stepDotColorKey("whatever"))
    }

    @Test fun `loading label prefers the newest running tool title`() {
        val out = cotSteps(
            null,
            "r",
            listOf(
                LiveTool("Read", args("/a.txt"), "running"),
                LiveTool("Read", args("/b.txt"), "running"),
                LiveTool("Bash", null, "done"),
            ),
            null,
            live = true,
        )
        assertEquals("Read b.txt", loadingLabel(out, "running Read…"))
        val idle = cotSteps(null, "r", listOf(LiveTool("Bash", null, "done")), null, live = true)
        assertEquals("thinking…", loadingLabel(idle, "thinking…"))
        assertNull(loadingLabel(idle, null))
        assertNull(loadingLabel(emptyList(), " "))
    }

    @Test fun `tool result text renders strings, text blocks, and JSON`() {
        assertNull(toolResultText(null))
        assertNull(toolResultText(JsonNull))
        assertEquals("plain", toolResultText(JsonPrimitive("plain")))
        assertEquals("42", toolResultText(JsonPrimitive(42)))
        val blocks = buildJsonArray {
            addJsonObject { put("type", "text"); put("text", "one") }
            addJsonObject { put("type", "text"); put("text", "two") }
        }
        assertEquals("one\ntwo", toolResultText(blocks))
        val mixed = buildJsonArray { add(1); add("x") }
        val json = toolResultText(mixed)!!
        assertTrue(json.contains("\n"))
        val obj = toolResultText(buildJsonObject { put("ok", true) })!!
        assertTrue(obj.contains("\"ok\": true"))
    }

    @Test fun `arguments block prefers args then input`() {
        val step = CotStep.Tool(null, "Read", "Read x", "done", args("/x"), JsonPrimitive("raw"), null, live = false)
        assertTrue(toolArgsText(step)!!.contains("\"file_path\": \"/x\""))
        assertEquals("\"raw\"", toolArgsText(step.copy(args = null)))
        assertNull(toolArgsText(step.copy(args = null, input = null)))
    }

    @Test fun `sheet preview caps long text`() {
        assertEquals("short", sheetPreview("short"))
        val long = "a".repeat(30)
        assertEquals("a".repeat(10) + "\n…", sheetPreview(long, max = 10))
    }

    @Test fun `bounded result caps at max and flags the cut`() {
        assertNull(boundedResult(null))
        assertEquals(BoundedResult("abc", false), boundedResult("abc", max = 3))
        assertEquals(BoundedResult("abc", true), boundedResult("abcd", max = 3))
        val big = liveResultPreview(JsonPrimitive("z".repeat(LIVE_RESULT_PREVIEW_MAX + 1)))!!
        assertEquals(LIVE_RESULT_PREVIEW_MAX, big.text.length)
        assertTrue(big.truncated)
        assertNull(liveResultPreview(JsonNull))
    }

    @Test fun `live tool step carries the preview and its truncated flag`() {
        val out = cotSteps(null, "", listOf(LiveTool("Bash", status = "done", resultPreview = "x", resultTruncated = true)), null, live = true)
        val t = out.single() as CotStep.Tool
        assertEquals("x", t.resultText)
        assertTrue(t.resultTruncated)
    }
}
