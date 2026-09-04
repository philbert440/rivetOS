package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.MdBlock
import io.rivethub.app.plane.MdInline
import io.rivethub.app.plane.MdListItem
import io.rivethub.app.plane.parseMarkdown
import io.rivethub.app.ui.term.copyText
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun MarkdownBody(
    text: String,
    modifier: Modifier = Modifier,
) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        blocks.forEach { MarkdownBlock(it) }
    }
}

@Composable
private fun MarkdownBlock(block: MdBlock, modifier: Modifier = Modifier) {
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
        is MdBlock.Fence -> FencedCode(lang = block.lang, code = block.code)
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
private fun FencedCode(lang: String, code: String) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.md)
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    val copiedCd = stringResource(R.string.cd_copied)
    val copyLabel = stringResource(R.string.action_copy)
    val copyCd = stringResource(R.string.cd_copy_code)
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, colors.line, shape)
            .background(colors.codeBg, shape),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(lang, color = colors.inkDim, style = RivetType.mono10)
            Text(
                if (copied) copiedCd else copyLabel,
                color = if (copied) colors.em else colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier
                    .sizeIn(minWidth = 44.dp, minHeight = 32.dp)
                    .semantics {
                        contentDescription = if (copied) copiedCd else copyCd
                        role = Role.Button
                    }
                    .clickable(role = Role.Button, onClick = {
                        copyText(ctx, code)
                        copied = true
                        scope.launch {
                            delay(1500)
                            copied = false
                        }
                    })
                    .wrapContentSize(Alignment.Center),
            )
        }
        Text(
            code,
            color = colors.ink,
            style = RivetType.mono11.copy(fontSize = 12.sp),
            modifier = Modifier.padding(12.dp),
        )
    }
}
