package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AskUserCard
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun AskUserCardView(
    card: AskUserCard,
    onSubmit: (Map<Int, List<String>>, String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    var picked by remember { mutableStateOf(mapOf<Int, List<String>>()) }
    var free by remember { mutableStateOf("") }
    val shape = RoundedCornerShape(Radius.md)
    Column(
        modifier
            .fillMaxWidth()
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel, shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(stringResource(R.string.ask_rivet_asking), color = colors.ink, style = RivetType.sm)
        card.questions.forEachIndexed { qi, q ->
            Text(q.header ?: q.question ?: "", color = colors.ink, style = RivetType.sm)
            q.options.forEach { opt ->
                val selected = picked[qi].orEmpty().contains(opt.label)
                RivetButton(
                    text = opt.label,
                    onClick = {
                        picked = picked.toMutableMap().apply {
                            val cur = this[qi].orEmpty()
                            this[qi] = if (q.multiSelect) {
                                if (opt.label in cur) cur - opt.label else cur + opt.label
                            } else {
                                listOf(opt.label)
                            }
                        }
                    },
                    variant = RivetButtonVariant.Outline,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (selected) {
                    Text(stringResource(R.string.ask_user_selected), color = colors.em, style = RivetType.mono11)
                }
                opt.description?.let { Text(it, color = colors.inkDim, style = RivetType.xs) }
            }
        }
        RivetField(
            value = free,
            onValueChange = { free = it },
            placeholder = stringResource(R.string.ask_user_free),
        )
        RivetButton(
            text = stringResource(R.string.action_submit),
            onClick = { onSubmit(picked, free) },
            modifier = Modifier.fillMaxWidth(),
        )
        RivetButton(
            text = stringResource(R.string.action_cancel),
            onClick = onDismiss,
            variant = RivetButtonVariant.Ghost,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
