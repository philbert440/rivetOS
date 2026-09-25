package io.rivethub.app.ui.components

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.CODE_FOLD_AFTER_LINES
import io.rivethub.app.plane.MdBlock
import io.rivethub.app.plane.MdInline
import io.rivethub.app.plane.MdListItem
import io.rivethub.app.plane.TokKind
import io.rivethub.app.plane.codeView
import io.rivethub.app.plane.highlightCode
import io.rivethub.app.plane.langLabel
import io.rivethub.app.plane.parseMarkdown
import io.rivethub.app.plane.saveFileName
import io.rivethub.app.plane.saveMime
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun MarkdownBody(
    text: String,
    modifier: Modifier = Modifier,
    codeLineNumbers: Boolean = false,
    codeWrap: Boolean = false,
) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var fenceIndex = 0
        blocks.forEach { block ->
            if (block is MdBlock.Fence) fenceIndex++
            MarkdownBlock(block, index = fenceIndex, codeLineNumbers = codeLineNumbers, codeWrap = codeWrap)
        }
    }
}

@Composable
private fun MarkdownBlock(
    block: MdBlock,
    modifier: Modifier = Modifier,
    index: Int = 1,
    codeLineNumbers: Boolean = false,
    codeWrap: Boolean = false,
) {
    when (block) {
        is MdBlock.Paragraph -> InlineLine(block.inlines, modifier)
        is MdBlock.Heading -> {
            val style = when (block.level) {
                1 -> RivetType.lg
                2 -> RivetType.lg.copy(fontSize = 16.sp)
                else -> RivetType.sm.copy(fontWeight = FontWeight.SemiBold)
            }
            InlineLine(block.inlines, modifier, style = style)
        }
        is MdBlock.Quote -> {
            val colors = RivetTheme.colors
            Box(
                modifier
                    .fillMaxWidth()
                    .drawBehind {
                        val x = Dimens.line.toPx() / 2f
                        drawLine(colors.line, Offset(x, 0f), Offset(x, size.height), Dimens.line.toPx())
                    }
                    .padding(start = 8.dp),
            ) {
                InlineLine(block.inlines, color = colors.inkDim)
            }
        }
        is MdBlock.BulletList -> MdList(block.items, ordered = false, modifier)
        is MdBlock.OrderedList -> MdList(block.items, ordered = true, modifier)
        is MdBlock.Fence -> FencedCode(block.lang, block.code, index, codeLineNumbers, codeWrap)
        is MdBlock.Table -> MdTable(block)
    }
}

@Composable
private fun MdList(items: List<MdListItem>, ordered: Boolean, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        items.forEachIndexed { i, item ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    if (ordered) "${i + 1}." else "•",
                    color = RivetTheme.colors.ink,
                    style = RivetType.sm,
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    InlineLine(item.inlines)
                    item.children.forEach { child ->
                        MarkdownBlock(child, Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun MdTable(table: MdBlock.Table) {
    val colors = RivetTheme.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            table.headers.forEach { cell ->
                Text(cell, color = colors.ink, style = RivetType.mono11.copy(fontWeight = FontWeight.SemiBold))
            }
        }
        table.rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { cell ->
                    Text(cell, color = colors.ink, style = RivetType.mono11)
                }
            }
        }
    }
}

@Composable
private fun InlineLine(
    inlines: List<MdInline>,
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = RivetTheme.colors.ink,
    style: androidx.compose.ui.text.TextStyle = RivetType.sm,
) {
    val colors = RivetTheme.colors
    val uriHandler = LocalUriHandler.current
    val annotated = remember(inlines, colors.link, colors.codeBg, uriHandler) {
        buildAnnotatedString {
            inlines.forEach { inline ->
                when (inline) {
                    is MdInline.Text -> append(inline.text)
                    is MdInline.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                        append(inline.text)
                    }
                    is MdInline.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                        append(inline.text)
                    }
                    is MdInline.Code -> withStyle(
                        SpanStyle(
                            fontFamily = RivetFonts.Mono,
                            background = colors.codeBg,
                            fontSize = 13.sp,
                        ),
                    ) { append(inline.text) }
                    is MdInline.Link -> {
                        val href = inline.href
                        withLink(
                            LinkAnnotation.Clickable(
                                tag = href,
                                styles = TextLinkStyles(
                                    style = SpanStyle(
                                        color = colors.link,
                                        textDecoration = TextDecoration.Underline,
                                    ),
                                ),
                            ) {
                                if (href.startsWith("https://", ignoreCase = true) ||
                                    href.startsWith("http://", ignoreCase = true)
                                ) {
                                    runCatching { uriHandler.openUri(href) }
                                }
                            },
                        ) { append(inline.text) }
                    }
                }
            }
        }
    }
    Text(
        annotated,
        modifier = modifier,
        style = style.copy(color = color),
    )
}

@Composable
private fun FencedCode(
    lang: String,
    code: String,
    index: Int,
    codeLineNumbers: Boolean,
    codeWrap: Boolean,
) {
    val colors = RivetTheme.colors
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    // Keep expansion while streamed content grows at this block's composition position.
    var expanded by remember { mutableStateOf(false) }
    // Never put the full snippet in the activity saved-state Bundle.
    var pendingSave by remember { mutableStateOf<String?>(null) }
    val currentCode by rememberUpdatedState(code)
    val view = remember(code, expanded) { codeView(code, expanded) }
    val canCollapse = expanded && view.lines.size > CODE_FOLD_AFTER_LINES
    val codeStyle = RivetType.mono11.copy(fontSize = 12.sp)
    val displayCode = remember(view.lines) { view.lines.joinToString("\n") }
    val spans = remember(lang, displayCode) { highlightCode(lang, displayCode) }
    val annotated = remember(displayCode, spans, colors) {
        buildAnnotatedString {
            append(displayCode)
            spans.forEach { span ->
                addStyle(
                    SpanStyle(
                        color = when (span.kind) {
                            TokKind.Keyword -> colors.em
                            TokKind.String -> colors.warn
                            TokKind.Comment -> colors.inkDim
                            TokKind.Number -> colors.link
                            else -> colors.ink
                        },
                        fontWeight = if (span.kind == TokKind.Type) FontWeight.Bold else FontWeight.Normal,
                    ),
                    span.start, span.end,
                )
            }
        }
    }
    val annotatedLines = remember(annotated, view.lines) {
        var offset = 0
        view.lines.map { line ->
            annotated.subSequence(offset, offset + line.length).also { offset += line.length + 1 }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(saveMime(lang))) { uri ->
        val snapshot = pendingSave ?: currentCode
        pendingSave = null
        if (uri != null) {
            scope.launch {
                val saved = withContext(Dispatchers.IO) {
                    runCatching {
                        val stream = ctx.contentResolver.openOutputStream(uri)
                            ?: error("No output stream")
                        stream.use { it.write(snapshot.toByteArray(Charsets.UTF_8)) }
                    }.isSuccess
                }
                Toast.makeText(ctx, if (saved) R.string.code_saved else R.string.code_save_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }
    val shape = RoundedCornerShape(Radius.sm)
    val saveCd = stringResource(R.string.save_code)
    val scroll = rememberScrollState()
    val measurer = rememberTextMeasurer()
    val gutterPx = if (codeLineNumbers) {
        remember(view.lines.size, measurer, codeStyle) {
            measurer.measure(AnnotatedString("9".repeat(view.lines.size.toString().length)), codeStyle).size.width
        }
    } else 0
    val gutterWidth = with(LocalDensity.current) { gutterPx.toDp() } + 12.dp
    Column(
        Modifier.fillMaxWidth().clip(shape).border(Dimens.line, colors.line, shape).background(colors.codeBg),
    ) {
        Row(
            Modifier.fillMaxWidth().background(colors.panel)
                .drawBehind { drawLine(colors.line, Offset(0f, size.height), Offset(size.width, size.height), Dimens.line.toPx()) }
                .padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(langLabel(lang), color = colors.inkDim, style = RivetType.mono11, maxLines = 1, modifier = Modifier.weight(1f))
            CopyGlyph(onCopy = { copyText(ctx, code) }, contentDescription = stringResource(R.string.copy_code))
            Box(
                Modifier.size(Dimens.touchTarget)
                    .semantics { contentDescription = saveCd }
                    .clickable(role = Role.Button) {
                        pendingSave = code
                        save.launch(saveFileName(lang, index))
                    },
                contentAlignment = Alignment.Center,
            ) {
                Lucide(R.drawable.lucide_download, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(16.dp))
            }
        }
        Column(
            Modifier.fillMaxWidth()
                .then(if (codeWrap) Modifier else Modifier.horizontalScroll(scroll))
                .padding(12.dp),
        ) {
            annotatedLines.forEachIndexed { lineIndex, line ->
                Row(if (codeWrap) Modifier.fillMaxWidth() else Modifier) {
                    if (codeLineNumbers) {
                        Text(
                            (lineIndex + 1).toString(),
                            color = colors.inkDim,
                            style = codeStyle,
                            textAlign = TextAlign.End,
                            modifier = Modifier.width(gutterWidth).padding(end = 12.dp),
                        )
                    }
                    Text(
                        line,
                        color = colors.ink,
                        style = codeStyle,
                        softWrap = codeWrap,
                        modifier = if (codeWrap) Modifier.weight(1f) else Modifier,
                    )
                }
            }
        }
        if (view.folded || canCollapse) {
            Text(
                if (view.folded) "▾ ${pluralStringResource(R.plurals.code_more_lines, view.hiddenLines, view.hiddenLines)}"
                else "▴ ${stringResource(R.string.code_collapse)}",
                color = colors.inkDim,
                style = RivetType.mono11,
                modifier = Modifier.fillMaxWidth().background(colors.panel)
                    .clickable(role = Role.Button) { expanded = !expanded }
                    .sizeIn(minHeight = Dimens.touchTarget)
                    .padding(horizontal = 12.dp)
                    .wrapContentSize(Alignment.CenterStart),
            )
        }
    }
}
