package io.rivethub.app.plane

sealed class RelativeAge {
    data object Empty : RelativeAge()
    data object Now : RelativeAge()
    data class Minutes(val n: Int) : RelativeAge()
    data class Hours(val n: Int) : RelativeAge()
    data class Days(val n: Int) : RelativeAge()
    data class Weeks(val n: Int) : RelativeAge()
}

fun relativeAge(thenMs: Long, nowMs: Long): RelativeAge {
    if (thenMs <= 0L) return RelativeAge.Empty
    val d = (nowMs - thenMs).coerceAtLeast(0L)
    return when {
        d < 60_000L -> RelativeAge.Now
        d < 3_600_000L -> RelativeAge.Minutes((d / 60_000L).toInt().coerceAtLeast(1))
        d < 86_400_000L -> RelativeAge.Hours((d / 3_600_000L).toInt().coerceAtLeast(1))
        d < 7 * 86_400_000L -> RelativeAge.Days((d / 86_400_000L).toInt().coerceAtLeast(1))
        else -> RelativeAge.Weeks((d / (7 * 86_400_000L)).toInt().coerceAtLeast(1))
    }
}
