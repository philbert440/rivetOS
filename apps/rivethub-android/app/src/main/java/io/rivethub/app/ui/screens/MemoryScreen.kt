package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.MemoryStatsModel
import io.rivethub.app.plane.MemoryTab
import io.rivethub.app.plane.Staleness
import io.rivethub.app.plane.StalenessKind
import io.rivethub.app.plane.WikiTopicRow
import io.rivethub.app.plane.browseRows
import io.rivethub.app.plane.memorySearching
import io.rivethub.app.plane.memoryStats
import io.rivethub.app.plane.memoryTabs
import io.rivethub.app.plane.topicRowModel
import io.rivethub.app.plane.wikiRows
import io.rivethub.app.ui.MemoryViewModel
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.TopBar
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import io.rivethub.app.transport.NodeRef

/**
 * The native Memory hub — mirrors the merged responsive web Memory hub
 * (MemoryHubPage + pages/memory.tsx at phone width): the one-row TopBar
 * (☰ + page title, MobileTopBar vocabulary), the Search / Wiki / Browse /
 * Stats tab strip (MemoryHubNav narrow), the search field, and compact topic
 * rows (title + staleness badge, `topicRowDensity` compact). A non-blank
 * query drives server-side wiki search on ANY tab (web MemoryPage); the tabs
 * shape the index client-side (Wiki = alphabetical, Browse = recent changes,
 * Stats = staleness counts + longest unverified). No spinners (D2-8): the
 * loading state is a dim mono line, an unreachable datahub is the web's
 * "Point RivetHub at datahub" pointer copy.
 */
@Composable
fun MemoryScreen(
    vm: MemoryViewModel,
    nodes: List<NodeRef>,
    onOpenDrawer: () -> Unit,
    onOpenTopic: (String) -> Unit,
) {
    val st by vm.state.collectAsState()
    val colors = RivetTheme.colors
    LaunchedEffect(nodes) { vm.bind(nodes) }

    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(
            title = stringResource(R.string.title_memory),
            onOpenDrawer = onOpenDrawer,
        )
        MemoryTabRow(
            tab = st.tab,
            onTab = vm::setTab,
        )
        RivetField(
            value = st.query,
            onValueChange = vm::setQuery,
            placeholder = stringResource(R.string.memory_search_placeholder),
            size = RivetFieldSize.Filter,
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
        )
        // weight, not fillMaxSize: the content takes exactly what the header,
        // tabs, and field leave — fillMaxSize would overflow and clip the bottom.
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                st.error != null -> MemoryPointerState(error = st.error, onRetry = vm::refresh)
                !st.loaded || (st.loading && st.topics.isEmpty()) -> MemoryLoadingLine()
                else -> MemoryHubContent(st, onOpenTopic)
            }
        }
    }
}

@Composable
private fun MemoryHubContent(st: MemoryViewModel.UiState, onOpenTopic: (String) -> Unit) {
    val nowMs = remember(st.topics) { System.currentTimeMillis() }
    when {
        memorySearching(st.query) -> MemoryTopicList(
            rows = st.topics.map { topicRowModel(it, nowMs) },
            emptyText = stringResource(R.string.memory_empty_search),
            onOpenTopic = onOpenTopic,
        )
        st.tab == MemoryTab.Wiki -> MemoryTopicList(
            rows = wikiRows(st.topics, nowMs),
            emptyText = stringResource(R.string.memory_empty_topics),
            onOpenTopic = onOpenTopic,
        )
        st.tab == MemoryTab.Browse -> MemoryTopicList(
            rows = browseRows(st.topics, nowMs),
            emptyText = stringResource(R.string.memory_empty_topics),
            onOpenTopic = onOpenTopic,
        )
        st.tab == MemoryTab.Stats -> MemoryStatsContent(
            stats = memoryStats(st.topics, st.total, nowMs),
            onOpenTopic = onOpenTopic,
        )
        else -> MemoryHintLine() // Search tab, blank query
    }
}

/** MemoryHubNav narrow: `border-b border-line bg-panel/60 px-2 py-1.5 gap-1`, scrollable chips. */
@Composable
private fun MemoryTabRow(tab: MemoryTab, onTab: (MemoryTab) -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.panel.copy(alpha = 0.6f))
            .drawBehind {
                val y = size.height - 1.dp.toPx() / 2f
                drawLine(colors.line, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
            }
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        memoryTabs().forEach { t ->
            val active = t == tab
            val shape = RoundedCornerShape(Radius.sm)
            Text(
                memoryTabLabel(t),
                color = if (active) colors.em else colors.inkDim,
                style = RivetType.sm,
                maxLines = 1,
                modifier = Modifier
                    .clip(shape)
                    .then(if (active) Modifier.background(colors.panel2) else Modifier)
                    .clickable { onTab(t) }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun memoryTabLabel(tab: MemoryTab): String = stringResource(
    when (tab) {
        MemoryTab.Search -> R.string.memory_tab_search
        MemoryTab.Wiki -> R.string.memory_tab_wiki
        MemoryTab.Browse -> R.string.memory_tab_browse
        MemoryTab.Stats -> R.string.memory_tab_stats
    },
)

/** Compact topic rows (web TopicList narrow): `divide-y`, `min-h-11`, title em + staleness badge. */
@Composable
private fun MemoryTopicList(rows: List<WikiTopicRow>, emptyText: String, onOpenTopic: (String) -> Unit) {
    val colors = RivetTheme.colors
    LazyColumn(
        Modifier
            .fillMaxSize()
            .navigationBarsPadding()
            .padding(horizontal = 12.dp),
    ) {
        if (rows.isEmpty()) {
            item {
                Text(
                    emptyText,
                    color = colors.inkDim,
                    style = RivetType.sm,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            }
        }
        items(rows, key = { it.slug }) { row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .drawBehind {
                        val y = size.height - 1.dp.toPx() / 2f
                        drawLine(colors.line, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
                    }
                    .clickable { onOpenTopic(row.slug) }
                    .padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    row.title,
                    color = colors.em,
                    style = RivetType.sm.copy(fontSize = 15.sp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                StalenessBadge(row.staleness)
            }
        }
    }
}

/** Web Badge: `rounded-full border bg-bg px-2 py-0.5 font-mono text-[10px]`, kind → em/warn/red. */
@Composable
internal fun StalenessBadge(staleness: Staleness) {
    val colors = RivetTheme.colors
    val tint = when (staleness.kind) {
        StalenessKind.Fresh -> colors.em
        StalenessKind.Aging -> colors.warn
        StalenessKind.Stale, StalenessKind.Never -> colors.red
    }
    Text(
        staleness.label,
        color = tint,
        style = RivetType.mono10,
        maxLines = 1,
        modifier = Modifier
            .padding(start = 8.dp)
            .border(1.dp, tint, RoundedCornerShape(999.dp))
            .background(colors.bg, RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
private fun MemoryStatsContent(stats: MemoryStatsModel, onOpenTopic: (String) -> Unit) {
    val colors = RivetTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .navigationBarsPadding()
            .padding(12.dp),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .border(1.dp, colors.line, RoundedCornerShape(Radius.lg))
                .background(colors.panel, RoundedCornerShape(Radius.lg))
                .padding(16.dp),
        ) {
            Text(
                stringResource(
                    R.string.memory_stats_line,
                    stats.total, stats.fresh, stats.aging, stats.stale, stats.never,
                ),
                color = colors.ink,
                style = RivetType.sm,
            )
            if (stats.stalest.isNotEmpty()) {
                Text(
                    stringResource(R.string.memory_stats_stalest),
                    color = colors.ink,
                    style = RivetType.lg.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
                )
                stats.stalest.forEach { row ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp)
                            .clickable { onOpenTopic(row.slug) }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            row.title,
                            color = colors.em,
                            style = RivetType.sm,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        StalenessBadge(row.staleness)
                    }
                }
            }
        }
    }
}

/** Web MemoryHubPage `!endpoint`: centered pointer copy (title semibold em + ink-dim body). */
@Composable
private fun MemoryPointerState(error: String?, onRetry: () -> Unit) {
    val colors = RivetTheme.colors
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            stringResource(R.string.title_memory),
            color = colors.em,
            style = RivetType.sm.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(
            stringResource(R.string.memory_pointer_body),
            color = colors.inkDim,
            style = RivetType.sm,
        )
        if (error != null) {
            Text(error, color = colors.red, style = RivetType.mono10)
        }
        Box(
            Modifier
                .clip(RoundedCornerShape(Radius.sm))
                .border(1.dp, colors.line, RoundedCornerShape(Radius.sm))
                .clickable(onClick = onRetry)
                .padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Text(
                stringResource(R.string.memory_retry),
                color = colors.inkDim,
                style = RivetType.xs,
            )
        }
    }
}

@Composable
private fun MemoryLoadingLine() {
    Text(
        stringResource(R.string.memory_loading),
        color = RivetTheme.colors.inkDim,
        style = RivetType.sm,
        modifier = Modifier.padding(12.dp),
    )
}

@Composable
private fun MemoryHintLine() {
    Text(
        stringResource(R.string.memory_search_hint),
        color = RivetTheme.colors.inkDim,
        style = RivetType.sm,
        modifier = Modifier.padding(12.dp),
    )
}
