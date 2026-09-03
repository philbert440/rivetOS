package io.rivethub.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * 40dp round grey button — the Grok Bot header/action affordance.
 * Visual size stays compact; the hit area is padded to the 48dp minimum.
 */
@Composable
fun CircleIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    background: Color = MaterialTheme.colorScheme.surfaceVariant,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    size: Int = 40,
) {
    Box(
        modifier
            .minimumInteractiveComponentSize()
            .size(size.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = tint, modifier = Modifier.size((size * 0.5).dp))
    }
}

@Composable
fun PulsingDot(color: Color = MaterialTheme.colorScheme.primary, size: Int = 8) {
    val t = rememberInfiniteTransition(label = "pulse")
    val a by t.animateFloat(
        initialValue = 0.35f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "alpha",
    )
    Box(Modifier.size(size.dp).alpha(a).clip(CircleShape).background(color))
}

@Composable
fun VSpace(dp: Int) = Spacer(Modifier.height(dp.dp))

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
