package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.gateway.WikiPageResponse
import io.rivethub.app.plane.TocEntry
import io.rivethub.app.plane.tocFromMarkdown
import io.rivethub.app.plane.wikiBody
import io.rivethub.app.plane.wikiDateLabel
import io.rivethub.app.plane.wikiLinksToMarkdown
import io.rivethub.app.ui.MemoryViewModel
import io.rivethub.app.ui.components.Lucide
import io.rivethub.app.ui.components.MarkdownBody
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * One wiki topic — the web MemoryTopicPage at phone width (wikiShellMode
 * stacked, tocMode disclosure): a one-row header with Back (the session-row
 * vocabulary — no TopBar, no ☰; the screen still lives inside HubDrawer so
 * the left-edge swipe opens the rail), the title over a border, the "From
 * RivetOS memory" lead, a collapsible full-width Contents built from the
 * parsed ## / ### headings, then the article body through MarkdownBody
 * (currentState, else the full file — web ArticleBody). A 404 is the web
 * red-link state, not an error.
 */
@Composable
fun MemoryTopicScreen(
    vm: MemoryViewModel,
    slug: String,
    onBack: () -> Unit,
) {
    val t by vm.topic.collectAsState()
    val colors = RivetTheme.colors
    LaunchedEffect(slug) { vm.openTopic(slug) }

    Column(Modifier.fillMaxSize().background(colors.bg)) {
        MemoryTopicHeader(title = t.page?.title ?: slug, onBack = onBack)
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 16.dp),
        ) {
            when {
                t.loading -> Text(
                    stringResource(R.string.memory_loading),
                    color = colors.inkDim,
                    style = RivetType.sm,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
                t.notFound -> MemoryRedLink(slug)
                t.error != null -> Text(
                    t.error ?: "",
                    color = colors.red,
                    style = RivetType.sm,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
                t.page != null -> MemoryTopicBody(t.page!!)
                else -> Text( // first frame, before the openTopic effect lands
                    stringResource(R.string.memory_loading),
                    color = colors.inkDim,
                    style = RivetType.sm,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
            }
        }
    }
}

/** Session-header vocabulary: one row owning the status inset, back arrow + title. */
@Composable
private fun MemoryTopicHeader(title: String, onBack: () -> Unit) {
    val colors = RivetTheme.colors
    val backCd = stringResource(R.string.action_back)
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.8f))
            .statusBarsPadding()
            .drawBehind {
                val y = size.height - Dimens.line.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), Dimens.line.toPx())
            }
            .height(Dimens.pageHeader)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            Modifier
                .size(Dimens.touchTarget)
                .semantics {
                    contentDescription = backCd
                    role = Role.Button
                }
                .clickable(role = Role.Button, onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(
                R.drawable.lucide_arrow_left,
                contentDescription = null,
                tint = colors.inkDim,
                modifier = Modifier.size(20.dp),
            )
        }
        Text(
            title,
            color = colors.em,
            style = RivetType.mono14,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MemoryTopicBody(page: WikiPageResponse) {
    val colors = RivetTheme.colors
    val bodyMd = wikiBody(page)
    val toc = remember(bodyMd) { tocFromMarkdown(bodyMd) }

    Text(
        page.title,
        color = colors.ink,
        style = RivetType.lg.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .drawBehind {
                val y = size.height - 1.dp.toPx() / 2f + 4.dp.toPx()
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
            }
            .padding(bottom = 8.dp),
    )
    Text(
        stringResource(R.string.memory_subtitle),
        color = colors.inkDim,
        style = RivetType.sm,
        modifier = Modifier.padding(top = 4.dp),
    )
    Text(
        stringResource(
            R.string.memory_meta_line,
            wikiDateLabel(page.lastVerified),
            wikiDateLabel(page.updatedAt),
        ),
        color = colors.inkDim,
        style = RivetType.mono11,
        modifier = Modifier.padding(top = 4.dp),
    )

    if (toc.size > 1) {
        MemoryContents(toc)
    }

    MarkdownBody(
        text = wikiLinksToMarkdown(bodyMd.ifBlank { "_No current state section yet._" }),
        modifier = Modifier.padding(top = 16.dp, bottom = 32.dp),
    )
}

/** Web narrow Contents: a bordered disclosure (`details`/`summary`), full width at the top. */
@Composable
private fun MemoryContents(toc: List<TocEntry>) {
    val colors = RivetTheme.colors
    var open by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .border(1.dp, colors.line, RoundedCornerShape(Radius.lg))
            .background(colors.panel.copy(alpha = 0.8f), RoundedCornerShape(Radius.lg))
            .padding(12.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { open = !open },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Lucide(
                if (open) R.drawable.lucide_chevron_down else R.drawable.lucide_chevron_right,
                contentDescription = null,
                tint = colors.inkDim,
                modifier = Modifier.size(12.dp),
            )
            Text(
                stringResource(R.string.memory_contents),
                color = colors.inkDim,
                style = RivetType.mono10,
            )
        }
        if (open) {
            Column(
                Modifier.padding(top = 8.dp, start = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                toc.forEachIndexed { i, e ->
                    Text(
                        "${i + 1}. ${e.text}",
                        color = if (e.level == 3) colors.inkDim else colors.em,
                        style = RivetType.sm,
                        modifier = Modifier.padding(start = if (e.level == 3) 12.dp else 0.dp),
                    )
                }
            }
        }
    }
}

/** Web red-link state (MemoryTopicPage 404): the slug as H1 + the teach-the-mesh copy. */
@Composable
private fun MemoryRedLink(slug: String) {
    val colors = RivetTheme.colors
    Text(
        slug,
        color = colors.ink,
        style = RivetType.lg.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        modifier = Modifier.padding(top = 16.dp, bottom = 8.dp),
    )
    Text(
        stringResource(R.string.memory_red_link_body),
        color = colors.inkDim,
        style = RivetType.sm,
    )
}
