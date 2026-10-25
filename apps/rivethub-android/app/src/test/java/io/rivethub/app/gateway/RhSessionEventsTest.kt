package io.rivethub.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RhSessionEventsTest {
    private val native = "0088c9b1-d99f-47bc-aa41-f4b2490470d7"

    @Test fun `snapshot rows become session-created with canonical ids`() {
        val text = """{"type":"snapshot","v":1,"sessions":[
            {"id":"$native","name":"$native","harness":"claude-code","lastEventTs":1792596122773,"pty":"pty-6e646404"},
            {"id":"other","harness":"codex"}]}"""
        val events = parseRhSessionEvents(text)
        assertEquals(listOf("claude-code:$native", "codex:other"), events.map { it.sessionId })
        assertEquals("claude-code", events.first().summary.harnessId)
        assertEquals("claude-code:$native", events.first().summary.sessionId)
    }

    @Test fun `session start becomes session-created`() {
        val text = """{"v":1,"session":"$native","type":"session.start","harness":"claude-code","ts":1792596122773}"""
        assertEquals(listOf("claude-code:$native"), parseRhSessionEvents(text).map { it.sessionId })
    }

    @Test fun `a protocol chat's canonical id is kept as is`() {
        val text = """{"v":1,"session":"claude-code:$native","type":"session.start","harness":"claude-code"}"""
        assertEquals(listOf("claude-code:$native"), parseRhSessionEvents(text).map { it.sessionId })
    }

    @Test fun `agent sessions, unknown harnesses and other frames give nothing`() {
        assertTrue(parseRhSessionEvents("""{"v":1,"session":"s","type":"session.start","harness":"rivetos"}""").isEmpty())
        assertTrue(parseRhSessionEvents("""{"v":1,"session":"s","type":"session.start"}""").isEmpty())
        assertTrue(parseRhSessionEvents("""{"type":"snapshot","v":1,"sessions":[{"id":"s","harness":"nope"},{"harness":"codex"}]}""").isEmpty())
        assertTrue(parseRhSessionEvents("""{"v":1,"session":"s","type":"turn.end"}""").isEmpty())
        assertTrue(parseRhSessionEvents("not json").isEmpty())
    }
}
