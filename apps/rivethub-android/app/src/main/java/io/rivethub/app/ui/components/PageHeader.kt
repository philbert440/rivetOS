package io.rivethub.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.Dimens

/** 48dp page chrome: DenBot opens the drawer, then page-specific content. Not a Material TopAppBar. */
@Composable
fun PageHeader(
    onOpenDrawer: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .height(Dimens.pageHeader),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .minimumInteractiveComponentSize()
                .padding(horizontal = 12.dp)
                .clickable(role = Role.Button, onClick = onOpenDrawer),
            contentAlignment = Alignment.Center,
        ) {
            DenBot(
                size = Dimens.denBotHeader,
                decorative = true,
            )
        }
        Row(
            Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}

@Composable
fun DenBotButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = Dimens.denBotHeader,
    contentDescription: String? = stringResource(R.string.cd_open_drawer),
) {
    Box(
        modifier
            .minimumInteractiveComponentSize()
            .size(size + 16.dp)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        DenBot(size = size, decorative = contentDescription == null)
    }
}
