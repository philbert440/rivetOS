package io.rivethub.app.ui.components

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.gateway.ModelOption
import io.rivethub.app.plane.filterModels
import io.rivethub.app.plane.groupModels
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Composer Model pill (UX-SPEC §4): the [ComposerPickerPill] trigger that
 * opens [ModelSheet] instead of the plain select sheet. Options come from the
 * harness sheet only — never a hard-coded list.
 */
@Composable
fun ComposerModelPicker(
    label: String,
    compact: Boolean,
    models: List<ModelOption>,
    favourites: Set<String>,
    value: String,
    onPick: (String) -> Unit,
    onToggleFavourite: (String) -> Unit,
    title: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var open by remember { mutableStateOf(false) }
    ComposerPickerPill(
        icon = R.drawable.lucide_bot,
        label = label,
        compact = compact,
        title = title,
        onClick = { open = true },
        modifier = modifier,
        enabled = enabled,
    )
    ModelSheet(
        visible = open,
        models = models,
        favourites = favourites,
        current = value,
        onPick = {
            onPick(it)
            open = false
        },
        onToggleFavourite = onToggleFavourite,
        onDismiss = { open = false },
    )
}

/**
 * Model sheet: autofocused search, then a Favourites group (when any) and the
 * full sheet list, rendered from `plane/ModelPicker.kt`. Tap picks and
 * dismisses; long-press toggles the favourite star.
 */
@Composable
fun ModelSheet(
    visible: Boolean,
    models: List<ModelOption>,
    favourites: Set<String>,
    current: String,
    onPick: (String) -> Unit,
    onToggleFavourite: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    var query by remember { mutableStateOf("") }
    val favLabel = stringResource(R.string.models_favourites)
    val allLabel = stringResource(R.string.models_all)
    val groups = remember(models, favourites, query, favLabel, allLabel) {
        filterModels(groupModels(models, favourites, favLabel, allLabel), query)
    }
    val focus = remember { FocusRequester() }
    RivetModalSheet(onDismiss = onDismiss) {
        val searchHint = stringResource(R.string.models_search_hint)
        RivetField(
            value = query,
            onValueChange = { query = it },
            placeholder = searchHint,
            size = RivetFieldSize.Filter,
            modifier = Modifier
                .padding(horizontal = 8.dp, vertical = 4.dp)
                .focusRequester(focus)
                .semantics { contentDescription = searchHint },
        )
        LaunchedEffect(Unit) {
            // The sheet window attaches a frame after composition.
            withFrameNanos { }
            runCatching { focus.requestFocus() }
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 440.dp)) {
            groups.forEach { group ->
                item(key = "group:${group.label}") {
                    SectionHeader(
                        group.label,
                        Modifier.padding(start = 8.dp, end = 8.dp, top = 12.dp, bottom = 4.dp),
                    )
                }
                items(group.options, key = { "${group.label}:${it.id}" }) { m ->
                    ModelRow(
                        model = m,
                        active = m.id == current,
                        favourite = m.id in favourites,
                        onPick = { onPick(m.id) },
                        onToggleFavourite = { onToggleFavourite(m.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ModelRow(
    model: ModelOption,
    active: Boolean,
    favourite: Boolean,
    onPick: () -> Unit,
    onToggleFavourite: () -> Unit,
) {
    val colors = RivetTheme.colors
    val favCd = stringResource(R.string.favourite_model, model.label)
    val favState = stringResource(R.string.models_state_favourite)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Dimens.touchTarget)
            .clip(RoundedCornerShape(Radius.sm))
            .semantics {
                selected = active
                if (favourite) stateDescription = favState
            }
            .combinedClickable(
                role = Role.Button,
                onLongClickLabel = favCd,
                onLongClick = onToggleFavourite,
                onClick = onPick,
            )
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
            if (active) {
                Lucide(R.drawable.lucide_check, contentDescription = null, tint = colors.em, modifier = Modifier.size(16.dp))
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                model.label,
                color = if (active) colors.em else colors.ink,
                style = RivetType.sm,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (model.id != model.label) {
                Text(
                    model.id,
                    color = colors.inkDim,
                    style = RivetType.mono10,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (favourite) {
            Lucide(R.drawable.lucide_star, contentDescription = null, tint = colors.warn, modifier = Modifier.size(14.dp))
        }
    }
}
