package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.*
import io.rivethub.app.ui.components.SelectOption
import io.rivethub.app.ui.TasksViewModel
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun DelegateSheet(
    vm: TasksViewModel,
    initialGoal: String,
    onDismiss: () -> Unit,
    onCreated: (String) -> Unit,
    delegating: Boolean = true,
) {
    val state by vm.state.collectAsState()
    var goal by remember { mutableStateOf(initialGoal) }
    var selected by remember { mutableStateOf("") }
    var criteria by remember { mutableStateOf("") }
    val options = taskAgentOptions(state.catalog)
    val agent = selected.takeIf { id -> options.any { it.id == id && it.enabled } }
        ?: defaultTaskAgent(options).orEmpty()
    LaunchedEffect(Unit) { if (delegating) vm.loadCatalog() }
    RivetModalSheet(onDismiss = { if (!state.acting) onDismiss() }) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(if (delegating) R.string.delegate_title else R.string.new_task),
                color = RivetTheme.colors.em, style = RivetType.mono14)
            Text(stringResource(R.string.task_goal), color = RivetTheme.colors.inkDim, style = RivetType.xs)
            RivetField(goal, { goal = it }, stringResource(R.string.task_goal), singleLine = false)
            RivetSelect(agent, options.map { SelectOption(it.id, it.label, it.enabled, it.helper) },
                { selected = it }, title = stringResource(R.string.task_agent), modifier = Modifier.fillMaxWidth(),
                enabled = !state.acting)
            RivetField(criteria, { criteria = it }, stringResource(R.string.task_criteria_hint), singleLine = false)
            if (state.loading) Text(stringResource(R.string.tasks_loading), color = RivetTheme.colors.inkDim, style = RivetType.mono11)
            state.error?.let { Text(it, color = RivetTheme.colors.red, style = RivetType.xs) }
            RivetButton(stringResource(R.string.task_create),
                onClick = { vm.create(goal, agent, criteria, onCreated) },
                enabled = !state.acting && delegateGoalFromComposer(goal) != null && agent.isNotEmpty())
        }
    }
}
