package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

enum class ConversationRowStatus { None, InFlight, Alive }

@Composable
fun ConversationRowChrome(
    title: String,
    accent: Color,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
    onLong: () -> Unit,
    modifier: Modifier = Modifier,
    rowKey: String = "",
    active: Boolean = false,
    archived: Boolean = false,
    status: ConversationRowStatus = ConversationRowStatus.None,
    harness: String = "",
    swipeEnabled: Boolean = true,
) {
    val colors = RivetTheme.colors
    // chat.tsx:642-644 — idle rows are `text-ink-dim` (`group-hover:text-ink`
    // has no phone analog; the ripple covers press), active rows `text-em`.
    // Archived rows share the idle colour: the source distinguishes them only by section.
    val titleColor = if (active && !archived) colors.em else colors.inkDim
    val row: @Composable () -> Unit = {
        Row(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = onLong)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(
                Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(accent),
            )
            Text(
                title,
                color = titleColor,
                style = RivetType.xs,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            when (status) {
                ConversationRowStatus.InFlight -> PulseDot(colors.em)
                ConversationRowStatus.Alive -> Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(colors.em.copy(alpha = 0.4f)),
                )
                ConversationRowStatus.None -> Unit
            }
            if (harness.isNotBlank()) HarnessChip(harness)
        }
    }
    val wrap = modifier
        .fillMaxWidth()
        .padding(bottom = 4.dp)
        .clip(RoundedCornerShape(Radius.sm))
        .background(if (active) colors.panel2 else Color.Transparent)
    if (!swipeEnabled) {
        Box(wrap) { row() }
        return
    }
    key(rowKey) {
        val state = rememberSwipeToDismissBoxState(
            confirmValueChange = { v ->
                if (v == SwipeToDismissBoxValue.EndToStart) {
                    onArchive()
                    false
                } else false
            },
        )
        SwipeToDismissBox(
            state = state,
            enableDismissFromStartToEnd = false,
            backgroundContent = {
                // Only paint the swipe reveal while a swipe is actually in
                // progress — an always-on panel2 background shows through the
                // transparent idle row and turns every row into a card
                // (chat.tsx:631-684 rows are flat).
                if (state.dismissDirection == SwipeToDismissBoxValue.EndToStart) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(colors.panel2)
                            .padding(horizontal = 12.dp),
                        contentAlignment = Alignment.CenterEnd,
                    ) {
                        Lucide(
                            if (archived) R.drawable.lucide_archive_restore else R.drawable.lucide_archive,
                            contentDescription = stringResource(
                                if (archived) R.string.action_unarchive else R.string.action_archive,
                            ),
                            tint = colors.inkDim,
                            modifier = Modifier.size(12.dp),
                        )
                    }
                }
            },
            modifier = wrap,
        ) { row() }
    }
}
