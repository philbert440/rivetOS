package io.rivethub.app.ui.components

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.MessageAction
import io.rivethub.app.plane.inlineActions
import io.rivethub.app.plane.sheetActions
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Screen-local state for the message action surfaces (UX-SPEC §1.3): which
 * turn's action row is revealed, which turn's More sheet is open, the text
 * in the Select & copy sheet, and the turn awaiting a Regenerate confirm.
 */
@Stable
class MessageActionsState {
    var revealed by mutableStateOf<Int?>(null)
    var moreFor by mutableStateOf<Int?>(null)
    var selectText by mutableStateOf<String?>(null)
    var confirmRegenerate by mutableStateOf<Int?>(null)

    fun toggle(index: Int) {
        revealed = if (revealed == index) null else index
    }
}

/**
 * The action row under a completed message: Copy · Regenerate (assistant) ·
 * More. [onMore] opens the More sheet; Copy flashes its check like the
 * other copy glyphs.
 */
@Composable
fun MessageActionRow(
    actions: List<MessageAction>,
    onAction: (MessageAction) -> Unit,
    onMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val inline = inlineActions(actions)
    val more = sheetActions(actions)
    Row(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        inline.forEach { a ->
            when (a) {
                MessageAction.Copy -> CopyGlyph(onCopy = { onAction(MessageAction.Copy) })
                MessageAction.Regenerate -> ActionGlyph(
                    R.drawable.lucide_refresh_cw,
                    stringResource(R.string.regenerate),
                ) { onAction(MessageAction.Regenerate) }
                else -> Unit
            }
        }
        if (more.isNotEmpty()) {
            ActionGlyph(R.drawable.lucide_ellipsis, stringResource(R.string.more_actions), onMore)
        }
    }
}

/** A 44dp-hit glyph button drawn like [CopyGlyph]. */
@Composable
private fun ActionGlyph(icon: Int, label: String, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    Box(
        Modifier
            .size(Dimens.touchTarget)
            .clip(shape)
            .semantics {
                contentDescription = label
                role = Role.Button
            }
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .border(Dimens.line, colors.line, shape)
                .background(colors.panel.copy(alpha = 0.9f), shape)
                .padding(4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(12.dp))
        }
    }
}

/** More sheet: Select & copy, Edit (user messages), Share — in that order. */
@Composable
fun MessageMoreSheet(
    actions: List<MessageAction>,
    onAction: (MessageAction) -> Unit,
    onDismiss: () -> Unit,
) {
    RivetModalSheet(onDismiss = onDismiss) {
        sheetActions(actions).forEach { a ->
            val (icon, label) = when (a) {
                MessageAction.SelectCopy -> R.drawable.lucide_copy to R.string.select_and_copy
                MessageAction.Edit -> R.drawable.lucide_pencil to R.string.edit_message
                else -> R.drawable.lucide_share_2 to R.string.share_message
            }
            SheetRow(icon, stringResource(label)) {
                onDismiss()
                onAction(a)
            }
        }
    }
}

@Composable
private fun SheetRow(icon: Int, label: String, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Dimens.touchTarget)
            .clip(RoundedCornerShape(Radius.md))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(16.dp))
        Text(label, color = colors.ink, style = RivetType.sm)
    }
}

/** Select & copy: the full message text in a selectable, scrollable view. */
@Composable
fun SelectCopySheet(text: String, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    val maxH = LocalConfiguration.current.screenHeightDp.dp * 0.8f
    RivetModalSheet(onDismiss = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = maxH)
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                stringResource(R.string.select_and_copy),
                color = colors.em,
                style = RivetType.mono11.copy(fontWeight = FontWeight.SemiBold),
            )
            SelectionContainer(Modifier.verticalScroll(rememberScrollState())) {
                Text(text, color = colors.ink, style = RivetType.sm)
            }
        }
    }
}

/** System share sheet with the message text (`ACTION_SEND`, text/plain). */
fun shareMessageText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    val chooser = Intent.createChooser(send, null)
    if (context !is android.app.Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(chooser) }
}
