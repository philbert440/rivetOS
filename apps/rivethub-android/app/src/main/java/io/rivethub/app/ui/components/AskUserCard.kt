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
import io.rivethub.app.plane.AskCardMode
import io.rivethub.app.plane.AskUserCard
import io.rivethub.app.plane.askCardMode
import io.rivethub.app.plane.showsAskCustomAnswer
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun AskUserCardView(
    card: AskUserCard,
    onSubmit: (Map<Int, List<String>>, Map<Int, String>) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    error: String? = null,
    promptId: String? = null,
) {
    val colors = RivetTheme.colors
    var picked by remember(promptId, card.screen) { mutableStateOf(mapOf<Int, List<String>>()) }
    var freeByQ by remember(promptId, card.screen) { mutableStateOf(mapOf<Int, String>()) }
    val shape = RoundedCornerShape(Radius.md)
    val optionShape = RoundedCornerShape(Radius.lg)
    val screen = card.screen
    val only = card.questions.singleOrNull()
    val cardMode = if (only != null) askCardMode(only, screen) else AskCardMode.ANSWER
    val hideSubmit = (cardMode != AskCardMode.ANSWER && cardMode != AskCardMode.FREE_TEXT) ||
        (screen != null && screen.total > 1 && only != null && !only.multiSelect && cardMode != AskCardMode.FREE_TEXT)
    val clickSubmits = screen != null && screen.total > 1 && only != null &&
        !only.multiSelect && cardMode == AskCardMode.ANSWER
    Column(
        modifier
            .fillMaxWidth()
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel, shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            if (screen != null) {
                stringResource(R.string.ask_question_of, screen.current + 1, screen.total)
            } else {
                stringResource(R.string.ask_rivet_asking)
            },
            color = colors.ink,
            style = RivetType.sm,
        )
        if (screen != null && cardMode == AskCardMode.ANSWER && screen.total > 1 && screen.current < screen.total - 1) {
            Text(stringResource(R.string.ask_moves_terminal), color = colors.inkDim, style = RivetType.mono10)
        }
        card.questions.forEachIndexed { qi, q ->
            Text(q.header ?: q.question ?: "", color = colors.ink, style = RivetType.sm)
            val qMode = askCardMode(q, if (only != null) screen else null)
            when (qMode) {
                AskCardMode.FREE_TEXT -> {
                    RivetField(
                        value = freeByQ[qi].orEmpty(),
                        onValueChange = { if (enabled) freeByQ = freeByQ + (qi to it) },
                        placeholder = stringResource(R.string.ask_user_free),
                    )
                }
                AskCardMode.NO_OPTIONS -> {
                    Text(stringResource(R.string.ask_no_options), color = colors.inkDim, style = RivetType.mono11)
                }
                AskCardMode.TERMINAL_ONLY -> {
                    Text(stringResource(R.string.ask_terminal_only), color = colors.inkDim, style = RivetType.mono11)
                    q.options.forEach { opt ->
                        RivetButton(
                            text = opt.label,
                            onClick = {},
                            variant = RivetButtonVariant.Outline,
                            enabled = false,
                            textColor = colors.ink,
                            modifier = Modifier
                                .fillMaxWidth()
                                .border(Dimens.line, colors.line, optionShape)
                                .background(colors.panel2.copy(alpha = 0.4f), optionShape),
                        )
                        opt.description?.let { Text(it, color = colors.inkDim, style = RivetType.xs) }
                    }
                }
                AskCardMode.ANSWER -> {
                    q.options.forEach { opt ->
                        val selected = picked[qi].orEmpty().contains(opt.label)
                        RivetButton(
                            text = opt.label,
                            onClick = {
                                if (clickSubmits) {
                                    onSubmit(mapOf(0 to listOf(opt.label)), freeByQ)
                                } else {
                                    picked = picked.toMutableMap().apply {
                                        val cur = this[qi].orEmpty()
                                        this[qi] = if (q.multiSelect) {
                                            if (opt.label in cur) cur - opt.label else cur + opt.label
                                        } else {
                                            listOf(opt.label)
                                        }
                                    }
                                }
                            },
                            variant = RivetButtonVariant.Outline,
                            enabled = enabled,
                            textColor = if (selected) colors.em else colors.ink,
                            modifier = Modifier
                                .fillMaxWidth()
                                .border(
                                    Dimens.line,
                                    if (selected) colors.em else colors.line,
                                    optionShape,
                                )
                                .background(
                                    if (selected) colors.emDim.copy(alpha = 0.25f) else colors.panel2.copy(alpha = 0.4f),
                                    optionShape,
                                ),
                        )
                        if (selected) {
                            Text(stringResource(R.string.ask_user_selected), color = colors.em, style = RivetType.mono11)
                        }
                        opt.description?.let { Text(it, color = colors.inkDim, style = RivetType.xs) }
                    }
                    if (showsAskCustomAnswer(q, screen)) {
                        RivetField(
                            value = freeByQ[qi].orEmpty(),
                            onValueChange = { if (enabled) freeByQ = freeByQ + (qi to it) },
                            placeholder = stringResource(R.string.ask_user_free),
                        )
                    }
                }
            }
        }
        if (!hideSubmit) {
            RivetButton(
                text = stringResource(R.string.action_submit),
                onClick = { onSubmit(picked, freeByQ) },
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (!error.isNullOrBlank()) {
            Text(error, color = colors.red, style = RivetType.xs)
        }
        RivetButton(
            text = stringResource(R.string.action_cancel),
            onClick = onDismiss,
            variant = RivetButtonVariant.Ghost,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
