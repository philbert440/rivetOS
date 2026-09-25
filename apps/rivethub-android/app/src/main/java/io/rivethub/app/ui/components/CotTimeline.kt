package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import io.rivethub.app.R
import io.rivethub.app.plane.CotFold
import io.rivethub.app.plane.CotStep
import io.rivethub.app.plane.ReasoningSpan
import io.rivethub.app.plane.autoCollapse
import io.rivethub.app.plane.reasoningLabel
import io.rivethub.app.plane.reasoningLabelMs
import io.rivethub.app.plane.showCollapse
import io.rivethub.app.plane.stepDotColorKey
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetColors
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay

/** Rail stroke and the column it is centred in. */
private val RailWidth = 2.dp
private val RailColumn = 16.dp

/** Live reasoning preview height, in lines of mono 11sp. */
private const val PREVIEW_LINES = 6

/**
 * Chain-of-thought timeline (UX-SPEC §1.3): a 2dp `line` rail with one dot
 * per step. [fold] carries the visible steps; [stepCount] is the unfolded
 * total so the "collapse" row knows whether there is anything to fold.
 * [liveSpan] is the phone reasoning clock for the in-flight turn; [nowMs]
 * is the clock it was sampled with (the view model's), used by the label's
 * ticker so a synthetic clock drives both.
 */
@Composable
fun CotTimeline(
    fold: CotFold,
    stepCount: Int,
    expanded: Boolean,
    onToggleFold: () -> Unit,
    onToolTap: (CotStep.Tool) -> Unit,
    modifier: Modifier = Modifier,
    liveSpan: ReasoningSpan? = null,
    nowMs: () -> Long = System::currentTimeMillis,
) {
    val colors = RivetTheme.colors
    Column(modifier.fillMaxWidth()) {
        if (fold.hiddenCount > 0) {
            FoldRow(stringResource(R.string.cot_more, fold.hiddenCount), R.drawable.lucide_chevron_down, onToggleFold)
        }
        fold.visible.forEach { step ->
            when (step) {
                is CotStep.Reasoning -> {
                    val open = step.live && liveSpan != null && !autoCollapse(liveSpan)
                    RailRow(dotColor(colors, stepDotColorKey(if (open) "running" else "done")), pulse = open) {
                        ReasoningRow(step, liveSpan.takeIf { step.live }, nowMs)
                    }
                }
                is CotStep.Tool -> {
                    RailRow(dotColor(colors, stepDotColorKey(step.status)), pulse = step.status == "running") {
                        ToolStatusRow(
                            ToolRow(step.title, step.status),
                            showDot = false,
                            icon = R.drawable.lucide_zap,
                            onClick = { onToolTap(step) },
                        )
                    }
                }
            }
        }
        if (showCollapse(stepCount, expanded)) {
            FoldRow(stringResource(R.string.cot_collapse), R.drawable.lucide_chevron_up, onToggleFold)
        }
    }
}

private fun dotColor(colors: RivetColors, key: String): Color = when (key) {
    "em" -> colors.em
    "red" -> colors.red
    else -> colors.inkDim
}

/** One step: the rail is drawn behind the whole row so it runs unbroken from step to step. */
@Composable
private fun RailRow(dot: Color, pulse: Boolean, content: @Composable () -> Unit) {
    val rail = RivetTheme.colors.line
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                val x = RailColumn.toPx() / 2f
                drawLine(rail, Offset(x, 0f), Offset(x, size.height), RailWidth.toPx())
            },
    ) {
        Box(Modifier.width(RailColumn).padding(top = 9.dp), contentAlignment = Alignment.TopCenter) {
            if (pulse) {
                PulseDot(dot)
            } else {
                Box(Modifier.size(6.dp).clip(CircleShape).background(dot))
            }
        }
        Box(Modifier.weight(1f).padding(start = 4.dp, top = 2.dp, bottom = 2.dp)) { content() }
    }
}

@Composable
private fun FoldRow(label: String, icon: Int, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 28.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = RailColumn + 4.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(12.dp))
        Text(label, color = colors.inkDim, style = RivetType.mono11)
    }
}

/**
 * Reasoning step: lightbulb + "Reasoned for X.Xs". While the live span is
 * open, a six-line preview follows the text with faded edges; once it ends
 * the step is the one-line label and a tap toggles the full text.
 */
@Composable
private fun ReasoningRow(step: CotStep.Reasoning, span: ReasoningSpan?, nowMs: () -> Long) {
    val colors = RivetTheme.colors
    val ctx = LocalContext.current
    val template: (String) -> String = { ctx.getString(R.string.reasoned_for, it) }
    val live = span != null && !autoCollapse(span)
    var now by remember { mutableLongStateOf(nowMs()) }
    if (live) {
        // UI ticker for the "Reasoned for X.Xs" label only, while the span is
        // open. It fetches nothing and touches no state outside this label —
        // not a data poll (the chat path stays frame-driven; UX-SPEC §0.2).
        LaunchedEffect(span?.startMs) {
            while (true) {
                now = nowMs()
                delay(1_000)
            }
        }
    }
    val label = when {
        span != null -> reasoningLabel(span, now, template)
        step.durationMs != null -> reasoningLabelMs(step.durationMs, template)
        else -> stringResource(R.string.reasoning_step)
    }
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .sizeIn(minHeight = 24.dp)
                .clip(RoundedCornerShape(Radius.sm))
                .clickable(enabled = !live, role = Role.Button) { open = !open }
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Lucide(R.drawable.lucide_lightbulb, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(12.dp))
            Text(
                label,
                color = colors.inkDim,
                style = RivetType.mono11,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (!live) {
                Lucide(
                    if (open) R.drawable.lucide_chevron_up else R.drawable.lucide_chevron_down,
                    contentDescription = null,
                    tint = colors.inkDim,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
        when {
            live -> ReasoningPreview(step.text)
            open -> ThinkingBody(step.text)
        }
    }
}

/** Fixed-height live preview pinned to the newest line, faded top and bottom over `bg`. */
@Composable
private fun ReasoningPreview(text: String) {
    val colors = RivetTheme.colors
    val style = RivetType.mono11
    val density = LocalDensity.current
    val line = if (style.lineHeight.isSpecified) style.lineHeight else style.fontSize * 1.4f
    val height = with(density) { line.toDp() } * PREVIEW_LINES
    val scroll = rememberScrollState()
    LaunchedEffect(scroll) {
        snapshotFlow { scroll.maxValue }.collect { scroll.scrollTo(it) }
    }
    val fade = 16.dp
    Box(
        Modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(Radius.sm)),
    ) {
        Text(
            text,
            color = colors.inkDim,
            style = style,
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(scroll)
                .padding(horizontal = 4.dp, vertical = 4.dp),
        )
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .height(fade)
                .background(Brush.verticalGradient(listOf(colors.bg, colors.bg.copy(alpha = 0f)))),
        )
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(fade)
                .background(Brush.verticalGradient(listOf(colors.bg.copy(alpha = 0f), colors.bg))),
        )
    }
}
