package dev.rivet.app.ui.pages.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.rivet.app.R
import dev.rivet.app.data.harness.ApprovalDecision
import dev.rivet.app.data.harness.HarnessControlsState
import dev.rivet.app.data.harness.HarnessQuestionAnswer

/** Uses the same native requests on phone and desktop; no answers become pasted turns. */
@Composable
fun HarnessControls(
    state: HarnessControlsState,
    onModel: (String) -> Unit,
    onEffort: (String) -> Unit,
    onAnswer: (String, List<HarnessQuestionAnswer>) -> Unit,
    onApproval: (String, ApprovalDecision) -> Unit,
) {
    if (state.models.isEmpty() && state.prompts.isEmpty() && state.approvals.isEmpty() && state.error == null) return
    Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
        val selected = state.models.firstOrNull { it.id == state.model }
        if (state.models.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HarnessChoice(stringResource(R.string.harness_native_model), selected?.label ?: "", state.models.map { it.id to it.label }, onModel)
            if (!selected?.efforts.isNullOrEmpty()) HarnessChoice(
                stringResource(R.string.harness_native_effort), state.effort ?: "", selected!!.efforts.map { it to it }, onEffort,
            )
        }
        state.approvals.forEach { approval ->
            Text(approval.reason ?: approval.name)
            Row {
                TextButton(enabled = !state.submitting, onClick = { onApproval(approval.requestId, ApprovalDecision.ALLOW) }) { Text(stringResource(R.string.harness_native_allow)) }
                TextButton(enabled = !state.submitting, onClick = { onApproval(approval.requestId, ApprovalDecision.DENY) }) { Text(stringResource(R.string.harness_native_deny)) }
            }
        }
        state.prompts.forEach { prompt ->
            val answers = remember(prompt.promptId) { mutableStateMapOf<Int, String>() }
            prompt.questions.forEachIndexed { index, question ->
                Text(question.question, style = MaterialTheme.typography.bodyMedium)
                if (question.options.isNotEmpty()) HarnessChoice(
                    stringResource(R.string.harness_native_choice), answers[index] ?: "",
                    question.options.map { it to it }, { answers[index] = it },
                )
                OutlinedTextField(
                    value = answers[index] ?: "", onValueChange = { answers[index] = it },
                    label = { Text(stringResource(R.string.harness_native_answer)) },
                    enabled = !state.submitting, modifier = Modifier.fillMaxWidth(),
                )
            }
            TextButton(
                enabled = !state.submitting && prompt.questions.indices.all { !answers[it].isNullOrBlank() },
                onClick = {
                    onAnswer(prompt.promptId, prompt.questions.mapIndexed { index, question ->
                        val answer = answers[index]!!.trim()
                        HarnessQuestionAnswer(index, if (answer in question.options) listOf(answer) else emptyList(), if (answer in question.options) null else answer)
                    })
                },
            ) { Text(stringResource(R.string.harness_native_submit)) }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun HarnessChoice(label: String, value: String, options: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }) { Text("$label: $value") }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { onSelect(id); expanded = false }) }
        }
    }
}
