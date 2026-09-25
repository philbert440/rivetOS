package io.rivethub.app.plane

import kotlin.math.abs

val FONT_SCALE_STEPS = listOf(0.9f, 1.0f, 1.1f, 1.25f)
private val FONT_SCALE_LABELS = listOf("S", "M", "L", "XL")

// Ties prefer the smaller step. Invalid numeric input returns the default.
fun nearestFontScale(v: Float): Float {
    if (v.isNaN()) return 1f
    val bounded = v.coerceIn(FONT_SCALE_STEPS.first(), FONT_SCALE_STEPS.last())
    return FONT_SCALE_STEPS.minBy { abs(it - bounded) }
}

fun fontScaleLabel(v: Float): String =
    FONT_SCALE_LABELS[FONT_SCALE_STEPS.indexOf(nearestFontScale(v))]

fun fontScaleFromLabel(label: String): Float =
    FONT_SCALE_LABELS.indexOf(label).takeIf { it >= 0 }?.let { FONT_SCALE_STEPS[it] } ?: 1f
