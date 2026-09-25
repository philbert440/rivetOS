package io.rivethub.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.taskIsTerminal
import io.rivethub.app.ui.TasksViewModel
import io.rivethub.app.ui.components.*
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val taskResultJson = Json { prettyPrint = true }

@Composable
fun TaskDetailScreen(vm: TasksViewModel, id: String, onBack: () -> Unit) {
    val state by vm.state.collectAsState()
    var confirmKill by remember(id) { mutableStateOf(false) }
    val colors = RivetTheme.colors
    LaunchedEffect(id) { vm.open(id) }
    Column(Modifier.fillMaxSize().background(colors.bg)) {
        Row(Modifier.fillMaxWidth().background(colors.panel).statusBarsPadding().height(Dimens.pageHeader),
            verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(Dimens.touchTarget).clickable(role = Role.Button, onClick = onBack), contentAlignment = Alignment.Center) {
                Lucide(R.drawable.lucide_arrow_left, contentDescription = stringResource(R.string.task_back), tint = colors.inkDim,
                    modifier = Modifier.size(20.dp))
            }
            Text(id.take(8), color = colors.em, style = RivetType.mono14, modifier = Modifier.weight(1f))
            RivetButton(stringResource(R.string.tasks_refresh), onClick = { vm.open(id) }, enabled = !state.detailLoading)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).navigationBarsPadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Text(it, color = colors.red, style = RivetType.xs) }
            if (state.detailLoading) Text(stringResource(R.string.tasks_loading), color = colors.inkDim, style = RivetType.mono11)
            state.detail?.takeIf { it.id == id }?.let { task ->
                Text(task.goal, color = colors.ink, style = RivetType.sm)
                TaskStatusPill(task.status)
                Text(stringResource(R.string.task_agent_value, task.agentId), color = colors.inkDim, style = RivetType.mono11)
                Text(stringResource(R.string.task_executor_value, task.executor + task.executorTarget?.takeIf { it.isNotEmpty() }?.let { "/$it" }.orEmpty()),
                    color = colors.inkDim, style = RivetType.mono11)
                task.nodeAffinity?.takeIf { it.isNotBlank() }?.let {
                    Text(stringResource(R.string.task_node_value, it), color = colors.inkDim, style = RivetType.mono11)
                }
                task.requestedBy?.takeIf { it.isNotBlank() }?.let {
                    Text(stringResource(R.string.task_requested_by_value, it), color = colors.inkDim, style = RivetType.mono11)
                }
                task.result?.let {
                    TaskOutput(stringResource(R.string.task_result), taskResultJson.encodeToString(JsonObject.serializer(), it))
                }
                task.error?.let { TaskOutput(stringResource(R.string.task_error), it) }
                if (task.acceptanceCriteria.isNotEmpty()) {
                    Text(stringResource(R.string.task_criteria), color = colors.em, style = RivetType.mono11)
                    task.acceptanceCriteria.forEach { Text("${it.id} · ${it.description}", color = colors.ink, style = RivetType.sm) }
                }
                if (!taskIsTerminal(task.status)) {
                    RivetField(state.steerText, vm::setSteerText, stringResource(R.string.task_steer_hint), singleLine = false)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RivetButton(stringResource(R.string.task_send), onClick = { vm.steer(id, state.steerText) },
                            enabled = !state.acting && state.steerText.isNotBlank())
                        RivetButton(stringResource(R.string.task_kill), onClick = { confirmKill = true },
                            enabled = !state.acting, textColor = colors.red)
                    }
                }
            }
        }
    }
    if (confirmKill) RivetConfirmDialog(
        message = stringResource(R.string.task_kill_confirm),
        onConfirm = { confirmKill = false; vm.kill(id) }, onDismiss = { confirmKill = false },
        confirmLabel = stringResource(R.string.task_kill), cancelLabel = stringResource(R.string.task_cancel), danger = true,
    )
}

@Composable
private fun TaskOutput(title: String, text: String) {
    Text(title, color = RivetTheme.colors.em, style = RivetType.mono11)
    SelectionContainer {
        Text(text, color = RivetTheme.colors.ink, style = RivetType.mono11,
            modifier = Modifier.fillMaxWidth().background(RivetTheme.colors.codeBg).padding(12.dp))
    }
}
