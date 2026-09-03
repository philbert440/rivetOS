package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.rivethub.app.ui.theme.Dimens

/**
 * Split/mode pane placeholder: a [SegmentedControl] wired to a content slot.
 * Horizontal swipe paging is deferred to M4, which has a bounded chat body
 * to page; a gallery Column cannot give [androidx.compose.foundation.pager.HorizontalPager]
 * a measured height.
 */
@Composable
fun ModePager(
    pages: List<String>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (page: String) -> Unit,
) {
    Column(
        modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Dimens.grid),
    ) {
        SegmentedControl(options = pages, selected = selected, onSelect = onSelect)
        content(selected)
    }
}
