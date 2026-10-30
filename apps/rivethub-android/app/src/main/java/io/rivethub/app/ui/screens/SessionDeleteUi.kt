package io.rivethub.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.DeleteFailure
import io.rivethub.app.plane.DeleteOutcome
import io.rivethub.app.plane.FailedDelete
import io.rivethub.app.plane.ageLabel
import io.rivethub.app.plane.quotedList
import io.rivethub.app.plane.reviewableCandidates
import io.rivethub.app.ui.HubViewModel
import io.rivethub.app.ui.components.Lucide
import io.rivethub.app.ui.components.RivetButton
import io.rivethub.app.ui.components.RivetButtonSize
import io.rivethub.app.ui.components.RivetConfirmDialog
import io.rivethub.app.ui.components.RivetModalSheet
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/** “a”, “b”, “c” and N more — with the "and N more" tail from resources. */
@Composable
private fun rememberQuoted(): (List<String>) -> String {
    val res = LocalContext.current.resources
    return { labels -> quotedList(labels, more = { n -> res.getQuantityString(R.plurals.delete_and_more, n, n) }) }
}

/**
 * The one confirm every delete path goes through: it names the sessions and
 * says what goes (memory, the list row) and what stays (the transcript on
 * disk). Nothing is sent before Delete is tapped.
 */
@Composable
internal fun DeleteConfirmDialog(labels: List<String>, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val quoted = rememberQuoted()
    val message = if (labels.size == 1) {
        stringResource(R.string.delete_one_body, quoted(labels))
    } else {
        stringResource(R.string.delete_many_body, labels.size, quoted(labels))
    }
    RivetConfirmDialog(
        title = stringResource(R.string.delete_session_title),
        message = message,
        confirmLabel = stringResource(R.string.delete_confirm),
        cancelLabel = stringResource(R.string.action_cancel),
        danger = true,
        onConfirm = onConfirm,
        onDismiss = onDismiss,
    )
}

/** One line for the drawer after a delete attempt. */
@Composable
internal fun rememberDeleteNotice(): (DeleteOutcome, (String) -> String) -> String {
    val res = LocalContext.current.resources
    val quoted = rememberQuoted()
    return { outcome, labelOf ->
        val parts = ArrayList<String>()
        val n = outcome.deleted.size
        if (n == 1 && outcome.failed.isEmpty()) {
            parts += res.getString(R.string.delete_notice_one, quoted(listOf(labelOf(outcome.deleted[0]))))
        } else if (n > 0) {
            parts += res.getQuantityString(R.plurals.delete_notice_many, n, n)
        }
        fun group(kind: DeleteFailure): List<FailedDelete> = outcome.failed.filter { it.kind == kind }
        fun names(rows: List<FailedDelete>) = quoted(rows.map { labelOf(it.session) })
        val live = group(DeleteFailure.Live)
        val missing = group(DeleteFailure.NotFound)
        val other = group(DeleteFailure.Error)
        if (live.isNotEmpty()) {
            parts += res.getString(
                if (live.size == 1) R.string.delete_notice_live_one else R.string.delete_notice_live_many,
                names(live),
            )
        }
        if (missing.isNotEmpty()) {
            parts += res.getString(
                if (missing.size == 1) R.string.delete_notice_missing_one else R.string.delete_notice_missing_many,
                names(missing),
            )
        }
        if (other.isNotEmpty()) {
            val reason = other.singleOrNull()?.message?.takeIf { it.isNotBlank() }
            parts += if (reason != null) {
                res.getString(R.string.delete_notice_failed_reason, names(other), reason)
            } else {
                res.getString(R.string.delete_notice_failed, names(other))
            }
        }
        parts.joinToString(" ")
    }
}

/**
 * Under the drawer header: `select · clean up…`, or while selecting,
 * `N selected · delete N… · cancel`.
 */
@Composable
internal fun DeleteToolbar(
    selecting: Boolean,
    selectedCount: Int,
    onSelect: () -> Unit,
    onCleanUp: () -> Unit,
    onDeleteSelected: () -> Unit,
    onCancel: () -> Unit,
) {
    val colors = RivetTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (!selecting) {
            ToolbarText(stringResource(R.string.select_sessions), colors.inkDim, onClick = onSelect)
            Text("·", color = colors.inkDim, style = RivetType.mono10)
            ToolbarText(stringResource(R.string.clean_up_open), colors.inkDim, onClick = onCleanUp)
        } else {
            Text(
                stringResource(R.string.select_count, selectedCount),
                color = colors.ink,
                style = RivetType.mono10,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
            Text("·", color = colors.inkDim, style = RivetType.mono10)
            ToolbarText(
                stringResource(R.string.delete_selected, selectedCount),
                if (selectedCount > 0) colors.red else colors.inkDim,
                enabled = selectedCount > 0,
                onClick = onDeleteSelected,
            )
            Text("·", color = colors.inkDim, style = RivetType.mono10)
            ToolbarText(stringResource(R.string.select_cancel), colors.inkDim, onClick = onCancel)
        }
    }
}

@Composable
private fun ToolbarText(
    text: String,
    color: androidx.compose.ui.graphics.Color,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Text(
        text,
        color = color,
        style = RivetType.mono10,
        maxLines = 1,
        modifier = Modifier
            .sizeIn(minHeight = 32.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 8.dp),
    )
}

/** A check or empty box beside a selectable row. */
@Composable
internal fun SelectMark(selected: Boolean, enabled: Boolean = true) {
    val colors = RivetTheme.colors
    Lucide(
        if (selected) R.drawable.lucide_check else R.drawable.lucide_square,
        contentDescription = null,
        tint = when {
            !enabled -> colors.line
            selected -> colors.em
            else -> colors.inkDim
        },
        modifier = Modifier.size(14.dp),
    )
}

/**
 * Clean up…: the node's junk candidates (GET /api/sessions/trash on every
 * online node), minus renamed sessions and the open one. Nothing is
 * preselected; Delete selected goes through the same confirm. Deleted rows
 * leave the list; failures stay selected with their reason.
 */
@Composable
internal fun CleanupSheet(
    vm: HubViewModel,
    titleOverrides: Map<String, String>,
    openSessionKey: String?,
    onNotice: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    var load by remember { mutableStateOf<HubViewModel.TrashLoad?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var failures by remember { mutableStateOf(mapOf<String, FailedDelete>()) }
    var gone by remember { mutableStateOf(setOf<String>()) }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val notice = rememberDeleteNotice()
    val untitled = stringResource(R.string.cleanup_untitled)
    LaunchedEffect(Unit) { vm.loadTrash { load = it } }
    val rows = load?.let { l ->
        val exclude = setOfNotNull(openSessionKey)
        val keep = reviewableCandidates(l.rows.map { it.candidate }, { it in titleOverrides }, exclude)
            .map { it.session }.toSet()
        l.rows.filter { it.candidate.session in keep && it.candidate.session !in gone }
    }.orEmpty()
    val labelOf: (String) -> String = { id ->
        rows.find { it.candidate.session == id }?.candidate?.title?.takeIf { it.isNotBlank() } ?: untitled
    }
    val nowMs = System.currentTimeMillis()

    RivetModalSheet(onDismiss = onDismiss) {
        Text(stringResource(R.string.cleanup_title), color = colors.em, style = RivetType.sm, modifier = Modifier.padding(8.dp))
        val l = load
        when {
            l == null -> SheetLine(stringResource(R.string.cleanup_loading))
            l.unsupported -> SheetLine(stringResource(R.string.cleanup_unsupported))
            rows.isEmpty() -> SheetLine(stringResource(R.string.cleanup_empty))
            else -> {
                SheetLine(stringResource(R.string.cleanup_intro))
                val all = rows.map { it.candidate.session }.toSet()
                val allOn = selected.containsAll(all)
                Text(
                    stringResource(if (allOn) R.string.cleanup_select_none else R.string.cleanup_select_all),
                    color = colors.inkDim,
                    style = RivetType.mono10,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Radius.sm))
                        .clickable(role = Role.Button) { selected = if (allOn) emptySet() else all }
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                )
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                    items(rows, key = { it.candidate.session }) { row ->
                        val c = row.candidate
                        val on = c.session in selected
                        CandidateRow(
                            title = c.title?.takeIf { it.isNotBlank() } ?: untitled,
                            meta = listOf(
                                c.harness,
                                ageLabel(c.updatedAt, nowMs),
                                reasonLabel(c.reason),
                                row.nodeName,
                            ).filter { it.isNotBlank() }.joinToString(" · "),
                            reply = c.reply,
                            failure = failures[c.session],
                            selected = on,
                            onToggle = { selected = if (on) selected - c.session else selected + c.session },
                        )
                    }
                }
                RivetButton(
                    onClick = { confirming = true },
                    enabled = selected.isNotEmpty() && !busy,
                    size = RivetButtonSize.Sm,
                    modifier = Modifier.padding(top = 8.dp),
                ) {
                    Text(
                        stringResource(R.string.cleanup_delete_selected, selected.size),
                        color = if (selected.isNotEmpty()) colors.red else colors.inkDim,
                        style = RivetType.xs,
                    )
                }
            }
        }
        if (l != null && l.failedNodes > 0) {
            SheetLine(pluralStringResource(R.plurals.cleanup_nodes_failed, l.failedNodes, l.failedNodes))
        }
    }

    if (confirming) {
        val picked = rows.filter { it.candidate.session in selected }
        DeleteConfirmDialog(
            labels = picked.map { labelOf(it.candidate.session) },
            onConfirm = {
                confirming = false
                busy = true
                vm.deleteSessions(picked.map { HubViewModel.DeleteTarget(it.candidate.session, it.nodeDenUrl) }) { outcome ->
                    busy = false
                    val text = notice(outcome, labelOf)
                    gone = gone + outcome.deleted
                    failures = outcome.failed.associateBy { it.session }
                    selected = outcome.failed.map { it.session }.toSet()
                    onNotice(text)
                }
            },
            onDismiss = { confirming = false },
        )
    }
}

@Composable
private fun reasonLabel(reason: String): String = when (reason) {
    "empty" -> stringResource(R.string.cleanup_reason_empty)
    "one-word-reply" -> stringResource(R.string.cleanup_reason_one_word)
    else -> reason
}

@Composable
private fun CandidateRow(
    title: String,
    meta: String,
    reply: String?,
    failure: FailedDelete?,
    selected: Boolean,
    onToggle: () -> Unit,
) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .sizeIn(minHeight = 44.dp)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Checkbox, onClick = onToggle)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SelectMark(selected)
        Column(Modifier.weight(1f)) {
            Text(title, color = colors.ink, style = RivetType.xs, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(meta, color = colors.inkDim, style = RivetType.mono10, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!reply.isNullOrBlank()) {
                Text("“$reply”", color = colors.inkDim, style = RivetType.mono10, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (failure != null) {
                val why = when (failure.kind) {
                    DeleteFailure.Live -> stringResource(R.string.cleanup_failed_live)
                    DeleteFailure.NotFound -> stringResource(R.string.cleanup_failed_missing)
                    DeleteFailure.Error -> stringResource(R.string.cleanup_failed_error, failure.message)
                }
                Text(why, color = colors.red, style = RivetType.mono10, maxLines = 2)
            }
        }
    }
}

@Composable
private fun SheetLine(text: String) {
    Text(
        text,
        color = RivetTheme.colors.inkDim,
        style = RivetType.xs,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
    )
}
