package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn
import io.rivethub.app.plane.MessageAction.Copy
import io.rivethub.app.plane.MessageAction.Edit
import io.rivethub.app.plane.MessageAction.Regenerate
import io.rivethub.app.plane.MessageAction.SelectCopy
import io.rivethub.app.plane.MessageAction.Share
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageActionsTest {
    private fun u(text: String) = HarnessTranscriptTurn(role = "user", text = text)
    private fun a(text: String) = HarnessTranscriptTurn(role = "assistant", text = text)

    @Test
    fun `user messages copy, edit, select and share`() {
        assertEquals(listOf(Copy, Edit, SelectCopy, Share), messageActions("user", inFlight = false, hasPrecedingUser = false))
        assertEquals(listOf(Copy, Edit, SelectCopy, Share), messageActions("user", inFlight = true, hasPrecedingUser = true))
    }

    @Test
    fun `assistant regenerate needs a preceding user turn and no turn in flight`() {
        assertEquals(listOf(Copy, Regenerate, SelectCopy, Share), messageActions("assistant", inFlight = false, hasPrecedingUser = true))
        assertEquals(listOf(Copy, SelectCopy, Share), messageActions("assistant", inFlight = true, hasPrecedingUser = true))
        assertEquals(listOf(Copy, SelectCopy, Share), messageActions("assistant", inFlight = false, hasPrecedingUser = false))
    }

    @Test
    fun `row keeps copy and regenerate, the sheet the rest in fixed order`() {
        val user = messageActions("user", inFlight = false, hasPrecedingUser = false)
        assertEquals(listOf(Copy), inlineActions(user))
        assertEquals(listOf(SelectCopy, Edit, Share), sheetActions(user))
        val bot = messageActions("assistant", inFlight = false, hasPrecedingUser = true)
        assertEquals(listOf(Copy, Regenerate), inlineActions(bot))
        assertEquals(listOf(SelectCopy, Share), sheetActions(bot))
    }

    @Test
    fun `regenerate source is the nearest preceding user text without attachments`() {
        val turns = listOf(
            u("first"),
            a("one"),
            u("second\n[attached: /up/a.png]"),
            a("tool call"),
            a("two"),
        )
        assertEquals("second", regenerateSource(turns, 4))
        assertEquals("second", regenerateSource(turns, 3))
        assertEquals("first", regenerateSource(turns, 1))
    }

    @Test
    fun `regenerate source is null without a usable user turn`() {
        val turns = listOf(a("hello"), u("[attached: /up/only.png]"), a("seen"), u("q"))
        assertNull(regenerateSource(turns, 0))
        assertNull(regenerateSource(turns, 2))
        assertNull(regenerateSource(turns, 3))
        assertNull(regenerateSource(turns, 9))
        assertNull(regenerateSource(turns, -1))
    }

    @Test
    fun `edit source is the user body only`() {
        val turns = listOf(u("fix this\n[attached: /up/x.txt]"), a("ok"), u("  "))
        assertEquals("fix this", editSource(turns, 0))
        assertNull(editSource(turns, 1))
        assertNull(editSource(turns, 2))
        assertNull(editSource(turns, 5))
    }

    @Test
    fun `file-only and image-only user turns still get an action row`() {
        for (text in listOf("[attached: /up/report.pdf]", "[attached: /up/photo.png]")) {
            val (body, refs) = splitAttachedLines(text)
            assertEquals("", body.trim())
            val actions = messageActions("user", inFlight = false, hasPrecedingUser = false, hasBody = body.isNotBlank())
            assertEquals(listOf(Copy, SelectCopy, Share), actions)
            assertTrue(actionRowShown(always = false, revealed = true, actions = actions))
            assertEquals(listOf(Copy), inlineActions(actions))
            assertEquals(listOf(SelectCopy, Share), sheetActions(actions))
            assertEquals(refs.single().name, userActionText(body, refs))
        }
    }

    @Test
    fun `tool-only assistant turn offers only regenerate, and only when allowed`() {
        val allowed = messageActions("assistant", inFlight = false, hasPrecedingUser = true, hasBody = false)
        assertEquals(listOf(Regenerate), allowed)
        assertTrue(actionRowShown(always = true, revealed = false, actions = allowed))
        val none = messageActions("assistant", inFlight = true, hasPrecedingUser = true, hasBody = false)
        assertEquals(emptyList<MessageAction>(), none)
        assertFalse(actionRowShown(always = true, revealed = true, actions = none))
    }

    @Test
    fun `action row needs a reveal or the setting`() {
        val actions = messageActions("user", inFlight = false, hasPrecedingUser = false)
        assertFalse(actionRowShown(always = false, revealed = false, actions = actions))
        assertTrue(actionRowShown(always = true, revealed = false, actions = actions))
        assertTrue(actionRowShown(always = false, revealed = true, actions = actions))
    }

    @Test
    fun `user action text is the body, else the attachment names`() {
        val refs = listOf(AttachedRef("/up/a.png", "a.png", true), AttachedRef("/up/b.pdf", "b.pdf", false))
        assertEquals("hi", userActionText("hi", refs))
        assertEquals("a.png\nb.pdf", userActionText("  ", refs))
        assertEquals("", userActionText("", emptyList()))
    }
}
