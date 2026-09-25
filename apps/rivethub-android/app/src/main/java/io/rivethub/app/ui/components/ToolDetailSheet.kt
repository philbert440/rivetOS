package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.CotStep
import io.rivethub.app.plane.sheetPreview
import io.rivethub.app.plane.toolArgsText
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Tool detail sheet (UX-SPEC §1.3): the raw tool name, the arguments
 * pretty-printed, and the result text — monospace, scrollable, each block
 * with a copy glyph. A running call without a result says so; a live result
 * is a bounded preview and says so until the committed turn has the full text.
 */
@Composable
fun ToolDetailSheet(step: CotStep.Tool, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    val ctx = LocalContext.current
    val maxH = LocalConfiguration.current.screenHeightDp.dp * 0.8f
    val args = toolArgsText(step)
    val result = step.resultText
    val emptyResult = stringResource(
        if (step.status == "running") R.string.tool_no_result_yet else R.string.tool_no_result,
    )
    RivetModalSheet(onDismiss = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = maxH)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                step.name,
                color = colors.em,
                style = RivetType.mono11.copy(fontWeight = FontWeight.SemiBold),
            )
            Text(step.title, color = colors.inkDim, style = RivetType.xs)
            SheetBlock(
                label = stringResource(R.string.tool_arguments),
                text = args,
                empty = stringResource(R.string.tool_no_arguments),
                onCopy = { args?.let { copyText(ctx, it) } },
            )
            SheetBlock(
                label = stringResource(R.string.tool_result),
                text = result,
                empty = emptyResult,
                onCopy = { result?.let { copyText(ctx, it) } },
            )
            if (result != null && step.resultTruncated) {
                Text(stringResource(R.string.tool_result_truncated), color = colors.inkDim, style = RivetType.xs)
            }
        }
    }
}

@Composable
private fun SheetBlock(label: String, text: String?, empty: String, onCopy: () -> Unit) {
    val colors = RivetTheme.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                color = colors.inkDim,
                style = RivetType.mono11.copy(fontWeight = FontWeight.Medium),
                modifier = Modifier.weight(1f),
            )
            if (text != null) CopyGlyph(onCopy = onCopy)
        }
        val shape = RoundedCornerShape(Radius.md)
        Box(
            Modifier
                .fillMaxWidth()
                .background(colors.codeBg, shape)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Text(
                if (text != null) sheetPreview(text) else empty,
                color = if (text != null) colors.ink else colors.inkDim,
                style = RivetType.mono11,
                softWrap = false,
            )
        }
    }
}
