package io.rivethub.app.plane

import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeTurnTest {
    private val sheet = HarnessSheet(
        models = listOf(
            ModelOption(
                "gpt-5",
                "gpt-5",
                default = true,
                inputModalities = listOf("text", "image"),
            ),
        ),
        turnOptions = true,
        imageAttachments = true,
    )

    @Test fun `protocol turn carries model effort and staged images`() {
        val atts = listOf(StagedTurnAttachment("image/png", "/node/uploads/a.png", "a.png"))
        val turn = buildUserTurn("look", atts, sheet, "protocol", "gpt-5", "high")
        assertEquals("look", turn.text)
        assertEquals("gpt-5", turn.model)
        assertEquals("high", turn.effort)
        assertEquals("image/png", turn.attachments!!.single().mime)
        assertEquals("/node/uploads/a.png", turn.attachments!!.single().pathOrUri)
    }

    @Test fun `pty turn omits native fields even with staged files`() {
        val atts = listOf(StagedTurnAttachment("image/png", "/node/uploads/a.png", "a.png"))
        val turn = buildUserTurn("look", atts, sheet, "pty", "gpt-5", "high")
        assertNull(turn.model)
        assertNull(turn.effort)
        assertNull(turn.attachments)
    }

    @Test fun `unbound transport hides native controls`() {
        assertTrue(nativeTurnModels(sheet, null).isEmpty())
        assertFalse(nativeImageAttachments(sheet, null))
    }

    @Test fun `optimistic image-only bubble is a placeholder`() {
        val atts = listOf(StagedTurnAttachment("image/png", "/up/a.png", "a.png"))
        assertEquals("[Image]", optimisticUserText("", atts))
        assertEquals("caption\n[Image]", optimisticUserText("caption", atts))
        assertEquals("caption\n[Image]\n[Image]", optimisticUserText("caption", atts + atts))
        assertEquals("", optimisticUserText("", emptyList()))
        assertEquals("caption", optimisticUserText("caption", emptyList()))
    }
}
