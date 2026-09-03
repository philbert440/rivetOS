package io.rivethub.app.plane

import kotlinx.serialization.json.add
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AskUserTest {
    private fun obj(block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(block)

    @Test fun `recognizes claude grok and rivet names`() {
        assertTrue(isAskUserTool("AskUserQuestion"))
        assertTrue(isAskUserTool("ask_user_question"))
        assertTrue(isAskUserTool("ask_user"))
        assertTrue(isAskUserTool("🔧 ask_user"))
        assertFalse(isAskUserTool("Bash"))
    }

    @Test fun `extracts nested Claude questions with header description multiSelect`() {
        val args = obj {
            putJsonArray("questions") {
                add(obj {
                    put("question", "Which auth method?")
                    put("header", "Auth method")
                    put("multiSelect", false)
                    putJsonArray("options") {
                        add(obj { put("label", "JWT"); put("description", "Stateless tokens") })
                        add(obj { put("label", "Sessions") })
                    }
                })
                add(obj {
                    put("question", "Enable features?")
                    put("multiSelect", true)
                    putJsonArray("options") {
                        add(obj { put("label", "A") })
                        add(obj { put("label", "B") })
                    }
                })
            }
        }
        val qs = extractAskUserQuestions(args)
        assertEquals(2, qs.size)
        assertEquals("Which auth method?", qs[0].question)
        assertEquals("Auth method", qs[0].header)
        assertFalse(qs[0].multiSelect)
        assertEquals("JWT", qs[0].options[0].label)
        assertEquals("Stateless tokens", qs[0].options[0].description)
        assertTrue(qs[1].multiSelect)
    }

    @Test fun `extracts flat options and choices`() {
        val grok = extractAskUserQuestions(obj {
            put("question", "Go?")
            putJsonArray("options") { add("A"); add("B") }
        })
        assertEquals("Go?", grok.single().question)
        assertEquals(listOf("A", "B"), grok.single().options.map { it.label })
        val rivet = extractAskUserQuestions(obj { putJsonArray("choices") { add("yes"); add("no") } })
        assertEquals(listOf("yes", "no"), rivet.single().options.map { it.label })
    }

    @Test fun `yes_no without choices yields Yes No`() {
        val qs = extractAskUserQuestions(obj { put("type", "yes_no"); put("question", "Ship it?") })
        assertEquals("Ship it?", qs.single().question)
        assertEquals(listOf("Yes", "No"), qs.single().options.map { it.label })
    }

    @Test fun `dedupes options and caps at 20`() {
        val args = obj {
            putJsonArray("options") {
                add("X"); add("X")
                for (i in 0 until 25) add("o$i")
            }
        }
        val qs = extractAskUserQuestions(args)
        assertEquals(20, qs[0].options.size)
        assertEquals("X", qs[0].options[0].label)
    }

    @Test fun `degrades on missing or malformed args`() {
        assertEquals(emptyList<AskQuestion>(), extractAskUserQuestions(null))
        assertEquals(emptyList<AskQuestion>(), extractAskUserQuestions("not-json"))
        assertEquals(emptyList<AskQuestion>(), extractAskUserQuestions(obj { put("questions", "nope") }))
        assertEquals(emptyList<AskQuestion>(), extractAskUserQuestions(obj {
            putJsonArray("questions") { add(obj { put("question", "no options") }) }
        }))
    }

    @Test fun `parses JSON string args`() {
        val qs = extractAskUserQuestions("""{"choices":["1","2"]}""")
        assertEquals(listOf("1", "2"), qs[0].options.map { it.label })
    }

    @Test fun `questionsFromLiveTools uses the last ask-user tool`() {
        val qs = questionsFromLiveTools(
            listOf(
                LiveTool("Bash", status = "done"),
                LiveTool(
                    "AskUserQuestion",
                    args = obj {
                        putJsonArray("questions") {
                            add(obj {
                                put("question", "Go?")
                                putJsonArray("options") {
                                    add(obj { put("label", "Go") })
                                    add(obj { put("label", "Stop") })
                                }
                            })
                        }
                    },
                    status = "running",
                ),
            ),
        )
        assertEquals("Go?", qs.single().question)
        assertEquals(listOf("Go", "Stop"), qs.single().options.map { it.label })
    }

    @Test fun `returns empty when no args`() {
        assertEquals(emptyList<AskQuestion>(), questionsFromLiveTools(listOf(LiveTool("ask_user_question"))))
        assertNull(cardFromLiveTools(listOf(LiveTool("Bash"))))
    }

    @Test fun `keeps questions after the ask tool is done`() {
        val qs = questionsFromLiveTools(
            listOf(
                LiveTool(
                    "AskUserQuestion",
                    args = obj {
                        putJsonArray("questions") {
                            add(obj {
                                putJsonArray("options") {
                                    add(obj { put("label", "Go") })
                                    add(obj { put("label", "Stop") })
                                }
                            })
                        }
                    },
                    status = "done",
                ),
            ),
        )
        assertEquals(listOf("Go", "Stop"), qs[0].options.map { it.label })
        assertEquals(qs, cardFromLiveTools(listOf(
            LiveTool("AskUserQuestion", args = obj {
                putJsonArray("questions") {
                    add(obj {
                        putJsonArray("options") {
                            add(obj { put("label", "Go") })
                            add(obj { put("label", "Stop") })
                        }
                    })
                }
            }, status = "done"),
        ))!!.questions)
    }

    @Test fun `compose joins one question labels`() {
        val q = AskQuestion(multiSelect = true, options = listOf(AskOption("A"), AskOption("B")))
        assertEquals("A, B", composeAskAnswer(listOf(q), mapOf(0 to listOf("A", "B")), ""))
    }

    @Test fun `compose prefixes per-question when several are answered`() {
        val qs = listOf(
            AskQuestion(header = "Auth", options = listOf(AskOption("A"))),
            AskQuestion(question = "Which db?", options = listOf(AskOption("B"))),
        )
        assertEquals("Auth: A\nWhich db?: B", composeAskAnswer(qs, mapOf(0 to listOf("A"), 1 to listOf("B")), ""))
    }

    @Test fun `free text alone answers`() {
        val q = AskQuestion(options = listOf(AskOption("A")))
        assertEquals("my own take", composeAskAnswer(listOf(q), emptyMap(), "  my own take  "))
    }

    @Test fun `picks and free text combine`() {
        val q = AskQuestion(multiSelect = true, options = listOf(AskOption("A")))
        assertEquals("A\nalso: be careful", composeAskAnswer(listOf(q), mapOf(0 to listOf("A")), "also: be careful"))
        assertEquals("", composeAskAnswer(listOf(q), emptyMap(), "   "))
    }
}
