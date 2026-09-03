package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import io.rivethub.app.ui.theme.Dimens

/**
 * Split/mode pane: a [SegmentedControl] wired to a content slot. Pass
 * [swipe] when the caller can give the pager a bounded height (chat body).
 */
@Composable
fun ModePager(
    pages: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    swipe: Boolean = false,
    showControl: Boolean = true,
    content: @Composable (page: String) -> Unit,
) {
    if (!swipe) {
        Column(
            modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(Dimens.grid),
        ) {
            if (showControl) SegmentedControl(options = pages, selected = selected, onSelect = onSelect)
            content(selected)
        }
        return
    }
    val pagerState = rememberPagerState(
        initialPage = pages.indexOf(selected).coerceAtLeast(0),
        pageCount = { pages.size },
    )
    LaunchedEffect(selected) {
        val i = pages.indexOf(selected).coerceAtLeast(0)
        if (pagerState.currentPage != i) pagerState.animateScrollToPage(i)
    }
    LaunchedEffect(pagerState.currentPage, pagerState.isScrollInProgress) {
        if (!pagerState.isScrollInProgress) {
            val page = pages.getOrNull(pagerState.currentPage) ?: return@LaunchedEffect
            if (page != selected) onSelect(page)
        }
    }
    Column(modifier.fillMaxWidth()) {
        if (showControl) SegmentedControl(options = pages, selected = selected, onSelect = onSelect)
        HorizontalPager(state = pagerState, modifier = Modifier.weight(1f, fill = true)) { i ->
            content(pages[i])
        }
    }
}
