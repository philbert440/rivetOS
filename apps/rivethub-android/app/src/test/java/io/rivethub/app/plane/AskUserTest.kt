package io.rivethub.app.plane

import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.PromptScreen
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessAskQuestion
import io.rivethub.app.gateway.HarnessAskOption
import kotlinx.serialization.json.JsonNull
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

    @Test fun `never throws on non-primitive fields arrays of objects or nulls`() {
        val qs = extractAskUserQuestions(obj {
            putJsonArray("options") { add("A"); add("B") }
            put("header", buildJsonObject { put("nested", true) })
            putJsonArray("multiSelect") { add(true) }
            put("question", JsonNull)
        })
        assertEquals(1, qs.size)
        assertNull(qs[0].header)
        assertNull(qs[0].question)
        assertFalse(qs[0].multiSelect)
        assertEquals(listOf("A", "B"), qs[0].options.map { it.label })

        val fromObjectLabel = extractAskUserQuestions(obj {
            putJsonArray("options") {
                add(obj { put("label", buildJsonObject { put("x", 1) }) })
                add("Keep")
            }
        })
        assertEquals(listOf("Keep"), fromObjectLabel.single().options.map { it.label })

        val nestedNull = extractAskUserQuestions(obj {
            putJsonArray("questions") {
                add(obj {
                    putJsonArray("options") { add("A"); add("B") }
                    put("header", JsonNull)
                    put("multiSelect", JsonNull)
                })
            }
        })
        assertEquals(1, nestedNull.size)
        assertNull(nestedNull[0].header)
        assertFalse(nestedNull[0].multiSelect)
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

    @Test fun `promptAnswers emits one entry per question`() {
        val qs = listOf(
            AskQuestion(header = "A", options = listOf(AskOption("1"))),
            AskQuestion(header = "B", options = listOf(AskOption("2"))),
        )
        val answers = promptAnswers(qs, mapOf(0 to listOf("1"), 1 to listOf("2")), emptyMap())
        assertEquals(2, answers.size)
        assertEquals(0, answers[0].question)
        assertEquals(listOf("1"), answers[0].labels)
        assertEquals(1, answers[1].question)
        assertEquals(listOf("2"), answers[1].labels)
        assertNull(answers[0].other)
    }

    @Test fun `promptAnswers puts free text on other`() {
        val q = AskQuestion(options = listOf(AskOption("Go"), AskOption("Other")))
        val answers = promptAnswers(listOf(q), mapOf(0 to listOf("Other")), mapOf(0 to "typed extra"))
        assertEquals(listOf("Other"), answers.single().labels)
        assertEquals("typed extra", answers.single().other)
        val lone = promptAnswers(listOf(q), mapOf(0 to listOf("Go")), mapOf(0 to "also this"))
        assertEquals("also this", lone.single().other)
    }

    @Test fun `promptAnswers attaches other to the question it was typed under`() {
        val qs = listOf(
            AskQuestion(question = "Color", options = listOf(AskOption("Red"))),
            AskQuestion(question = "Name", freeText = true),
        )
        val answers = promptAnswers(qs, mapOf(0 to listOf("Red")), mapOf(1 to "River"))
        assertEquals(listOf("Red"), answers[0].labels)
        assertNull(answers[0].other)
        assertTrue(answers[1].labels.isEmpty())
        assertEquals("River", answers[1].other)
    }

    @Test fun `askQuestionsFromHarness copies wire questions`() {
        val wire = listOf(
            io.rivethub.app.gateway.HarnessAskQuestion(
                question = "Go?",
                header = "Auth",
                multiSelect = true,
                options = listOf(
                    io.rivethub.app.gateway.HarnessAskOption("Yes", "do it"),
                    io.rivethub.app.gateway.HarnessAskOption("No"),
                ),
            ),
        )
        val qs = askQuestionsFromHarness(wire)
        assertEquals("Go?", qs.single().question)
        assertEquals("Auth", qs.single().header)
        assertTrue(qs.single().multiSelect)
        assertEquals("Yes", qs.single().options[0].label)
        assertEquals("do it", qs.single().options[0].description)
        assertFalse(qs.single().freeText)
        val free = askQuestionsFromHarness(
            listOf(HarnessAskQuestion(question = "Name?", freeText = true)),
        )
        assertTrue(free.single().freeText)
        assertTrue(free.single().options.isEmpty())
    }

    private fun q(
        multiSelect: Boolean = false,
        options: List<AskOption> = listOf(AskOption("A"), AskOption("B")),
    ) = AskQuestion(multiSelect = multiSelect, options = options)

    @Test fun `askCardMode answers a normal question with no screen`() {
        assertEquals(AskCardMode.ANSWER, askCardMode(q()))
    }

    @Test fun `askCardMode is no-options when the option list is empty`() {
        assertEquals(AskCardMode.NO_OPTIONS, askCardMode(q(options = emptyList())))
        assertEquals(AskCardMode.NO_OPTIONS, askCardMode(q(options = emptyList()), AskScreen(2, 3)))
    }

    @Test fun `askCardMode is free-text when the marker is set`() {
        val free = AskQuestion(question = "Name?", options = emptyList(), freeText = true)
        assertEquals(AskCardMode.FREE_TEXT, askCardMode(free))
        assertEquals(AskCardMode.FREE_TEXT, askCardMode(free, AskScreen(0, 1)))
    }

    @Test fun `askCardMode keeps options when freeText is also set`() {
        val both = AskQuestion(freeText = true, options = listOf(AskOption("A")))
        assertEquals(AskCardMode.ANSWER, askCardMode(both))
        assertEquals(AskCardMode.ANSWER, askCardMode(both, AskScreen(0, 1)))
    }

    @Test fun `unmarked option questions keep a custom-answer field`() {
        val q = AskQuestion(options = listOf(AskOption("Red"), AskOption("Blue"), AskOption("Other")))
        assertFalse(q.freeText)
        assertEquals(AskCardMode.ANSWER, askCardMode(q))
        assertTrue(showsAskCustomAnswer(q))
        assertTrue(showsAskCustomAnswer(q, AskScreen(0, 1)))
    }

    @Test fun `freeText with options keeps options and a per-question field`() {
        val q = AskQuestion(freeText = true, options = listOf(AskOption("A"), AskOption("B")))
        assertEquals(AskCardMode.ANSWER, askCardMode(q))
        assertTrue(showsAskCustomAnswer(q))
        assertTrue(showsAskCustomAnswer(q, AskScreen(0, 1)))
    }

    @Test fun `freeText without options is a text-only card`() {
        val q = AskQuestion(question = "Name?", options = emptyList(), freeText = true)
        assertEquals(AskCardMode.FREE_TEXT, askCardMode(q))
        assertTrue(showsAskCustomAnswer(q))
        assertTrue(showsAskCustomAnswer(q, AskScreen(0, 1)))
    }

    @Test fun `custom-answer is hidden on a multi-question screen`() {
        val unmarked = AskQuestion(options = listOf(AskOption("Red"), AskOption("Blue")))
        assertFalse(showsAskCustomAnswer(unmarked, AskScreen(0, 3)))
        val marked = AskQuestion(freeText = true, options = listOf(AskOption("A")))
        assertFalse(showsAskCustomAnswer(marked, AskScreen(0, 3)))
    }

    @Test fun `askCardMode is terminal-only for the last single-select of several`() {
        assertEquals(AskCardMode.ANSWER, askCardMode(q(), AskScreen(0, 3)))
        assertEquals(AskCardMode.ANSWER, askCardMode(q(), AskScreen(1, 3)))
        assertEquals(AskCardMode.TERMINAL_ONLY, askCardMode(q(), AskScreen(2, 3)))
    }

    @Test fun `askCardMode still answers the last question when multiSelect or the only one`() {
        assertEquals(AskCardMode.ANSWER, askCardMode(q(multiSelect = true), AskScreen(2, 3)))
        assertEquals(AskCardMode.ANSWER, askCardMode(q(), AskScreen(0, 1)))
    }

    @Test fun `askCardError carries den bad_request text to the card`() {
        val err = GatewayException(400, "answer this one in the terminal", "bad_request")
        assertEquals("answer this one in the terminal", askCardError(err))
    }

    @Test fun `askCardError is null for every other failure so it goes to the strip`() {
        assertNull(askCardError(GatewayException(400, "answers must be …", null)))
        assertNull(askCardError(GatewayException(404, "unknown prompt", "unknown_prompt")))
        assertNull(askCardError(GatewayException(500, "HTTP 500", "upstream")))
        assertNull(askCardError(RuntimeException("boom")))
        assertNull(askCardError(GatewayException(400, "", "bad_request")))
    }

    private fun promptEvent(id: String, resolved: Boolean = false, screen: PromptScreen? = null) =
        HarnessEvent.Prompt(
            sessionId = "s",
            promptId = id,
            toolName = "AskUserQuestion",
            questions = listOf(
                HarnessAskQuestion(
                    question = "Which color?",
                    header = "Color",
                    options = listOf(HarnessAskOption("Red"), HarnessAskOption("Green")),
                ),
            ),
            resolved = resolved,
            screen = screen,
        )

    @Test fun `promptSlotAfter opens a slot and carries the screen position`() {
        val slot = promptSlotAfter(null, promptEvent("p1", screen = PromptScreen(1, 3)))
        assertEquals("p1", slot?.promptId)
        assertEquals(AskScreen(1, 3), slot?.card?.screen)
        assertEquals(listOf("Red", "Green"), slot?.card?.questions?.single()?.options?.map { it.label })
    }

    @Test fun `promptSlotAfter is idempotent by promptId (den replays on every open)`() {
        val first = promptSlotAfter(null, promptEvent("p1"))
        val again = promptSlotAfter(first, promptEvent("p1"))
        assertTrue(first === again)
    }

    @Test fun `promptSlotAfter resolved retires only the matching id`() {
        val slot = promptSlotAfter(null, promptEvent("p1"))
        assertTrue(promptSlotAfter(slot, promptEvent("other", resolved = true)) === slot)
        assertNull(promptSlotAfter(slot, promptEvent("p1", resolved = true)))
        assertNull(promptSlotAfter(null, promptEvent("p1", resolved = true)))
    }

    @Test fun `promptSlotAfter replaces the slot for a new id and ignores an empty frame`() {
        val slot = promptSlotAfter(null, promptEvent("p1"))
        val next = promptSlotAfter(slot, promptEvent("p2"))
        assertEquals("p2", next?.promptId)
        val empty = promptEvent("p3").copy(questions = emptyList())
        assertTrue(promptSlotAfter(next, empty) === next)
    }

    @Test fun `promptSlotAfter opens a free-text question with no options`() {
        val event = HarnessEvent.Prompt(
            sessionId = "s",
            promptId = "p-free",
            toolName = "requestUserInput",
            questions = listOf(HarnessAskQuestion(question = "Describe it", freeText = true)),
            resolved = false,
        )
        val slot = promptSlotAfter(null, event)
        assertEquals("p-free", slot?.promptId)
        assertTrue(slot!!.card.questions.single().freeText)
        assertEquals(AskCardMode.FREE_TEXT, askCardMode(slot.card.questions.single()))
    }
}
