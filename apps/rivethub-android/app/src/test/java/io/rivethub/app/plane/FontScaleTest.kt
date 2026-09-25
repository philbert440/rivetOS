package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Test

class FontScaleTest {
    @Test fun `labels round trip every step`() {
        assertEquals(listOf("S", "M", "L", "XL"), FONT_SCALE_STEPS.map(::fontScaleLabel))
        FONT_SCALE_STEPS.forEach { step ->
            assertEquals(step, fontScaleFromLabel(fontScaleLabel(step)), 0f)
            assertEquals(step, nearestFontScale(step), 0f)
        }
    }

    @Test fun `nearest chooses the closest step on either side`() {
        listOf(0.92f to 0.9f, 0.98f to 1f, 1.04f to 1f, 1.08f to 1.1f,
            1.17f to 1.1f, 1.175f to 1.1f, 1.19f to 1.25f).forEach { (input, expected) ->
            assertEquals(expected, nearestFontScale(input), 0f)
        }
    }

    @Test fun `out of range values clamp to endpoints`() {
        assertEquals(0.9f, nearestFontScale(-10f), 0f)
        assertEquals(1.25f, nearestFontScale(10f), 0f)
        assertEquals(0.9f, nearestFontScale(Float.NEGATIVE_INFINITY), 0f)
        assertEquals(1.25f, nearestFontScale(Float.POSITIVE_INFINITY), 0f)
    }

    @Test fun `invalid values use medium`() {
        assertEquals(1f, nearestFontScale(Float.NaN), 0f)
        assertEquals(1f, fontScaleFromLabel("unknown"), 0f)
        assertEquals("M", fontScaleLabel(Float.NaN))
    }
}
