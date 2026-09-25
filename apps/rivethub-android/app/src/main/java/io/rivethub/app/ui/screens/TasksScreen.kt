package io.rivethub.app.ui.screens

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.*
import io.rivethub.app.ui.TasksViewModel
import io.rivethub.app.ui.components.*
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun TasksScreen(vm: TasksViewModel, onOpenDrawer: () -> Unit, onOpenTask: (String) -> Unit) {
    val state by vm.state.collectAsState()
    var creating by remember { mutableStateOf(false) }
    val colors = RivetTheme.colors
    LaunchedEffect(Unit) { vm.refresh() }
    Column(Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(stringResource(R.string.tasks_title), onOpenDrawer)
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            RivetSelect(state.filter, statusFilterOptions().map {
                it.copy(label = if (it.value.isEmpty()) stringResource(R.string.tasks_all) else taskStatusLabel(it.value))
            }, vm::setFilter, title = stringResource(R.string.task_status))
            RivetButton(stringResource(R.string.new_task), onClick = { creating = true })
        }
        Row(Modifier.padding(horizontal = 12.dp)) {
            RivetButton(stringResource(R.string.tasks_refresh), onClick = vm::refresh, enabled = !state.loading)
        }
        state.error?.let { Text(it, color = colors.red, style = RivetType.xs, modifier = Modifier.padding(12.dp)) }
        if (state.loading) Text(stringResource(R.string.tasks_loading), color = colors.inkDim,
            style = RivetType.mono11, modifier = Modifier.padding(12.dp))
        LazyColumn(Modifier.weight(1f).navigationBarsPadding()) {
            if (!state.loading && state.error == null && state.tasks.isEmpty()) item {
                Text(stringResource(R.string.tasks_empty), color = colors.inkDim, style = RivetType.sm, modifier = Modifier.padding(16.dp))
            }
            items(state.tasks, key = { it.id }) { task ->
                Column(Modifier.fillMaxWidth().clickable { onOpenTask(task.id) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(task.goal, color = colors.ink, style = RivetType.sm, maxLines = 2,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        TaskStatusPill(task.status)
                    }
                    Text(taskRowSubtitle(task, System.currentTimeMillis()) { time, now ->
                        DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS).toString()
                    }, color = colors.inkDim, style = RivetType.mono11)
                }
            }
        }
    }
    if (creating) DelegateSheet(vm, "", { creating = false }, { creating = false; onOpenTask(it) }, delegating = false)
}

@Composable
internal fun taskStatusLabel(status: String): String = when (status) {
    "queued" -> stringResource(R.string.task_status_queued)
    "running" -> stringResource(R.string.task_status_running)
    "awaiting-input" -> stringResource(R.string.task_status_awaiting)
    "completed" -> stringResource(R.string.task_status_completed)
    "failed" -> stringResource(R.string.task_status_failed)
    "timeout" -> stringResource(R.string.task_status_timeout)
    "killed" -> stringResource(R.string.task_status_killed)
    else -> status
}

@Composable
internal fun TaskStatusPill(status: String) {
    Pill(taskStatusLabel(status), when (taskStatusTone(status)) {
        StatusTone.Neutral -> PillTone.Dim
        StatusTone.Live -> PillTone.Em
        StatusTone.Good -> PillTone.Good
        StatusTone.Bad -> PillTone.Bad
    })
}
