package io.rivethub.app.ui.components

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object TimeFmt {
    private val zone: ZoneId get() = ZoneId.systemDefault()
    private val clock = DateTimeFormatter.ofPattern("h:mm a", Locale.US)
    private val weekday = DateTimeFormatter.ofPattern("EEEE", Locale.US)
    private val shortDay = DateTimeFormatter.ofPattern("EEE", Locale.US)
    private val monthDay = DateTimeFormatter.ofPattern("MMM d", Locale.US)
    private val numeric = DateTimeFormatter.ofPattern("M/d/yy", Locale.US)

    private fun dayOf(ts: Long): LocalDate = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()

    /** Home list column: "8:41 AM" · "Yesterday" · "Tuesday" · "6/2/26". */
    fun listTime(ts: Long): String {
        if (ts <= 0) return ""
        val d = dayOf(ts); val today = LocalDate.now(zone)
        val z = Instant.ofEpochMilli(ts).atZone(zone)
        return when {
            d == today -> clock.format(z)
            d == today.minusDays(1) -> "Yesterday"
            d.isAfter(today.minusDays(7)) -> weekday.format(z)
            else -> numeric.format(z)
        }
    }

    /** Thread divider: "Today 7:58 AM" · "Yesterday 5:02 PM" · "Tue 3:10 PM" · "Aug 12, 3:10 PM". */
    fun divider(ts: Long): String {
        val d = dayOf(ts); val today = LocalDate.now(zone)
        val z = Instant.ofEpochMilli(ts).atZone(zone)
        val prefix = when {
            d == today -> "Today"
            d == today.minusDays(1) -> "Yesterday"
            d.isAfter(today.minusDays(7)) -> shortDay.format(z)
            else -> monthDay.format(z) + ","
        }
        return "$prefix ${clock.format(z)}"
    }

    fun date(ts: Long): String = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US).format(Instant.ofEpochMilli(ts).atZone(zone))
}
