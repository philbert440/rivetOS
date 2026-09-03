package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.MdBlock
import io.rivethub.app.plane.MdInline
import io.rivethub.app.plane.parseMarkdown
import io.rivethub.app.ui.term.copyText
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
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Paragraph -> InlineLine(block.inlines)
                is MdBlock.BulletList -> {
                    block.items.forEach { item ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("•", color = RivetTheme.colors.ink, style = RivetType.sm)
                            InlineLine(item, Modifier.weight(1f))
                        }
                    }
                }
                is MdBlock.OrderedList -> {
                    block.items.forEachIndexed { i, item ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("${i + 1}.", color = RivetTheme.colors.ink, style = RivetType.sm)
                            InlineLine(item, Modifier.weight(1f))
                        }
                    }
                }
                is MdBlock.Fence -> FencedCode(lang = block.lang, code = block.code)
            }
        }
    }
}

@Composable
private fun InlineLine(inlines: List<MdInline>, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    val annotated = remember(inlines, colors.link, colors.codeBg) {
        buildAnnotatedString {
            inlines.forEach { inline ->
                when (inline) {
                    is MdInline.Text -> append(inline.text)
                    is MdInline.Code -> withStyle(
                        SpanStyle(
                            fontFamily = RivetFonts.Mono,
                            background = colors.codeBg,
                            fontSize = 13.sp,
                        ),
                    ) { append(inline.text) }
                    is MdInline.Link -> withStyle(
                        SpanStyle(
                            color = colors.link,
                            textDecoration = TextDecoration.Underline,
                        ),
                    ) { append(inline.text) }
                }
            }
        }
    }
    Text(
        annotated,
        modifier = modifier,
        style = RivetType.sm.copy(color = colors.ink),
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
                if (copied) copiedCd else "copy",
                color = if (copied) colors.em else colors.inkDim,
                style = RivetType.mono10,
                modifier = Modifier.clickable(role = Role.Button, onClick = {
                    copyText(ctx, code)
                    copied = true
                    scope.launch {
                        delay(1500)
                        copied = false
                    }
                }),
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
