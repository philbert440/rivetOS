package io.rivethub.app.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.gateway.HubProject
import io.rivethub.app.plane.ProjectSection
import io.rivethub.app.plane.orderedProjects
import io.rivethub.app.ui.components.RivetButton
import io.rivethub.app.ui.components.RivetButtonVariant
import io.rivethub.app.ui.components.RivetField
import io.rivethub.app.ui.components.RivetFieldSize
import io.rivethub.app.ui.components.RivetModalSheet
import io.rivethub.app.ui.components.SheetTextRow
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * The drawer's Projects block (hub state slice 4): the projects desktop shows
 * as canvas spaces. One header row per project; tap folds it, "+" starts a
 * conversation in it, long-press offers rename and delete.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ProjectHeaderRow(
    section: ProjectSection,
    expanded: Boolean,
    onToggle: () -> Unit,
    onMenu: () -> Unit,
    onNew: () -> Unit,
) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = Dimens.touchTarget)
            .clip(RoundedCornerShape(Radius.sm))
            .combinedClickable(
                role = Role.Button,
                onClickLabel = stringResource(if (expanded) R.string.project_fold else R.string.project_unfold),
                onLongClickLabel = stringResource(R.string.project_options),
                onClick = onToggle,
                onLongClick = onMenu,
            )
            .padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            if (expanded) "▾" else "▸",
            color = colors.inkDim,
            style = RivetType.xs,
        )
        Text(
            section.project.name,
            color = colors.ink,
            style = RivetType.sm,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (section.running > 0) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(colors.em))
        }
        Text(
            section.rows.size.toString(),
            color = colors.inkDim,
            style = RivetType.mono10,
        )
        SmallOutlineButton(stringResource(R.string.action_new_plus), stringResource(R.string.project_new_session), onNew)
    }
}

/** `+ project` under the Projects label. */
@Composable
internal fun ProjectsLabelRow(onAdd: () -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp, top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.projects_label).uppercase(),
            color = colors.inkDim,
            style = RivetType.mono10,
            modifier = Modifier.weight(1f),
        )
        SmallOutlineButton(stringResource(R.string.project_add), stringResource(R.string.project_new_title), onAdd)
    }
}

@Composable
internal fun ProjectEmptyLine() {
    Text(
        stringResource(R.string.project_empty),
        color = RivetTheme.colors.inkDim,
        style = RivetType.xs,
        modifier = Modifier.padding(start = 34.dp, end = 12.dp, bottom = 6.dp),
    )
}

/** Create (blank [initial]) or rename a project. */
@Composable
internal fun ProjectNameSheet(title: String, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    var text by remember { mutableStateOf(initial) }
    RivetModalSheet(onDismiss = onDismiss) {
        Column(Modifier.imePadding()) {
            Text(title, color = colors.em, style = RivetType.sm, modifier = Modifier.padding(8.dp))
            RivetField(
                value = text,
                onValueChange = { text = it },
                placeholder = stringResource(R.string.project_name_hint),
                size = RivetFieldSize.Rename,
            )
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RivetButton(
                    text = stringResource(R.string.action_save),
                    enabled = text.isNotBlank(),
                    onClick = { onSave(text) },
                )
                RivetButton(
                    text = stringResource(R.string.action_cancel),
                    onClick = onDismiss,
                    variant = RivetButtonVariant.Outline,
                )
            }
        }
    }
}

@Composable
internal fun ProjectMenuSheet(name: String, onRename: () -> Unit, onDelete: () -> Unit, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    RivetModalSheet(onDismiss = onDismiss) {
        Text(
            name,
            color = colors.em,
            style = RivetType.sm,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(8.dp),
        )
        SheetTextRow(stringResource(R.string.project_rename_title), colors.ink, onRename)
        SheetTextRow(stringResource(R.string.project_delete), colors.red, onDelete)
    }
}

/** Long-press → Move to project: every project, then "No project". */
@Composable
internal fun MoveToProjectSheet(
    projects: List<HubProject>,
    currentId: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    RivetModalSheet(onDismiss = onDismiss) {
        Text(
            stringResource(R.string.move_to_project_title),
            color = colors.inkDim,
            style = RivetType.mono10,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
        orderedProjects(projects).forEach { project ->
            SheetTextRow(project.name, if (project.id == currentId) colors.em else colors.ink) { onPick(project.id) }
        }
        if (currentId != null) {
            SheetTextRow(stringResource(R.string.project_none), colors.inkDim) { onPick(null) }
        }
    }
}

/** The pane's bordered `+ new` look, with its own label. */
@Composable
internal fun SmallOutlineButton(label: String, description: String, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.sm)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .sizeIn(minWidth = Dimens.touchTarget, minHeight = Dimens.touchTarget)
            .clickable(role = Role.Button, onClickLabel = description, onClick = onClick),
    ) {
        Text(
            label,
            color = colors.inkDim,
            style = RivetType.xs,
            maxLines = 1,
            modifier = Modifier
                .clip(shape)
                .border(1.dp, colors.line, shape)
                .padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}
