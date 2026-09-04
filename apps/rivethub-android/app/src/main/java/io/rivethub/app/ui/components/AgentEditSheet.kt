package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.plane.AgentEditFields
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.HarnessSheet
import io.rivethub.app.plane.agentColorValid
import io.rivethub.app.plane.agentEffortOptions
import io.rivethub.app.plane.agentModelOptions
import io.rivethub.app.plane.defaultEffort
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Agent edit surface (web `agents-section.tsx` AgentEditor → a
 * [RivetModalSheet], the only Material chrome allowed): name, color, target
 * node, model, effort, system prompt. Unlike the web the node stays EDITABLE
 * on an existing agent (task 2026-09-04) and the harness is intentionally not
 * editable (no picker in the field list; `harnessId` never enters the PATCH).
 * Model/effort options come from the TARGET node's capability sheet via
 * [sheetFor], with the current value unshifted when unlisted (web
 * harness-options.ts behavior); changing the model re-derives the effort
 * default like the web editor. Save PATCHes through `HubViewModel.saveAgent`.
 */
@Composable
fun AgentEditSheet(
    row: AgentRow,
    nodeOptions: List<SelectOption>,
    sheetFor: (nodeDenUrl: String) -> HarnessSheet?,
    onSave: (fields: AgentEditFields, onDone: (ok: Boolean) -> Unit) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    var name by remember { mutableStateOf(row.name) }
    var color by remember { mutableStateOf(row.color) }
    var model by remember { mutableStateOf(row.model) }
    var effort by remember { mutableStateOf(row.effort) }
    var prompt by remember { mutableStateOf(row.systemPrompt) }
    var nodeBaseUrl by remember { mutableStateOf(row.nodeDenUrl.trim().trimEnd('/')) }
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    val nodes = remember(nodeOptions, nodeBaseUrl) {
        if (nodeBaseUrl.isBlank() || nodeOptions.any { it.value == nodeBaseUrl }) {
            nodeOptions
        } else {
            listOf(SelectOption(nodeBaseUrl, nodeBaseUrl)) + nodeOptions
        }
    }
    val sheet = sheetFor(nodeBaseUrl)
    val models = agentModelOptions(sheet, model).map { SelectOption(it.first, it.second) }
    val efforts = agentEffortOptions(sheet, model, effort).map { SelectOption(it.first, it.second) }
    val saveEnabled = name.isNotBlank() && agentColorValid(color) && !saving

    RivetModalSheet(onDismiss = { if (!saving) onDismiss() }) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(
                stringResource(R.string.agent_edit_title),
                color = colors.em,
                style = RivetType.sm,
                modifier = Modifier.padding(8.dp),
            )
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column {
                    FieldLabel(stringResource(R.string.agent_field_name))
                    RivetField(
                        value = name,
                        onValueChange = { name = it },
                        placeholder = stringResource(R.string.agent_name_hint),
                        size = RivetFieldSize.Rename,
                    )
                }
                Column {
                    FieldLabel(stringResource(R.string.agent_field_color))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            Modifier
                                .size(28.dp)
                                .clip(RoundedCornerShape(Radius.sm))
                                .border(1.dp, colors.line, RoundedCornerShape(Radius.sm))
                                .then(
                                    if (agentColorValid(color) && color.isNotBlank()) {
                                        Modifier.background(rivetHexColor(color.trim()))
                                    } else {
                                        Modifier
                                    },
                                ),
                        )
                        RivetField(
                            value = color,
                            onValueChange = { color = it },
                            placeholder = stringResource(R.string.agent_color_hint),
                            size = RivetFieldSize.Rename,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Column {
                    FieldLabel(stringResource(R.string.agent_field_node))
                    RivetSelect(
                        value = nodeBaseUrl,
                        options = nodes,
                        onChange = { nodeBaseUrl = it },
                        title = stringResource(R.string.agent_field_node),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (models.isNotEmpty()) {
                    Column {
                        FieldLabel(stringResource(R.string.agent_field_model))
                        RivetSelect(
                            value = model,
                            options = models,
                            onChange = {
                                model = it
                                effort = defaultEffort(sheet, it)
                            },
                            title = stringResource(R.string.agent_field_model),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (efforts.isNotEmpty()) {
                    Column {
                        FieldLabel(stringResource(R.string.agent_field_effort))
                        RivetSelect(
                            value = effort,
                            options = efforts,
                            onChange = { effort = it },
                            title = stringResource(R.string.agent_field_effort),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Column {
                    FieldLabel(stringResource(R.string.agent_field_prompt))
                    RivetField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        placeholder = stringResource(R.string.agent_prompt_hint),
                        singleLine = false,
                        size = RivetFieldSize.Rename,
                    )
                }
            }
            if (failed) {
                Text(
                    stringResource(R.string.agent_save_failed),
                    color = colors.red,
                    style = RivetType.xs,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            Row(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                RivetButton(
                    text = stringResource(R.string.action_save),
                    enabled = saveEnabled,
                    onClick = {
                        saving = true
                        failed = false
                        val fields = AgentEditFields(
                            name = name,
                            color = color,
                            model = model,
                            effort = effort,
                            systemPrompt = prompt,
                            nodeBaseUrl = if (nodeBaseUrl == row.nodeDenUrl.trim().trimEnd('/')) "" else nodeBaseUrl,
                        )
                        onSave(fields) { ok ->
                            saving = false
                            failed = !ok
                        }
                    },
                )
                RivetButton(
                    text = stringResource(R.string.action_cancel),
                    variant = RivetButtonVariant.Outline,
                    enabled = !saving,
                    onClick = onDismiss,
                )
            }
        }
    }
}
