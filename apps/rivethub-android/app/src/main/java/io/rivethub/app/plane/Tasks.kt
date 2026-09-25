package io.rivethub.app.plane

import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.gateway.TaskAcceptanceCriterion
import io.rivethub.app.gateway.TaskWire
import io.rivethub.app.gateway.isPreset

data class TaskAgentOption(val id: String, val label: String, val enabled: Boolean, val helper: String? = null)

private val taskAgentLabels = mapOf(
    "claude" to "Claude Code", "grok" to "grok Build", "grok-fast" to "grok Build (fast)",
    "hermes" to "Hermes", "local" to "local",
)
private val taskIdPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
fun isTaskId(id: String): Boolean = taskIdPattern.matches(id)

fun taskAgentOptions(catalog: List<CatalogAgent>): List<TaskAgentOption> {
    val ordered = catalog.filter { !it.isPreset && it.local } +
        catalog.filter { !it.isPreset && !it.local } + catalog.filter { it.isPreset }
    return ordered.distinctBy { it.id }.map { agent ->
        when {
            agent.isPreset -> TaskAgentOption(agent.id,
                "${agent.name} (agent · ${agent.harnessId ?: "no harness"} @ ${agent.node})",
                agent.implemented != false, if (agent.implemented == false) agent.gap ?: "no headless executor" else null)
            agent.local -> TaskAgentOption(agent.id,
                "${taskAgentLabels[agent.id] ?: agent.id}${agent.model?.takeIf { it.isNotEmpty() }?.let { " ($it)" }.orEmpty()} · this node", true)
            else -> TaskAgentOption(agent.id, "${taskAgentLabels[agent.id] ?: agent.id} @ ${agent.node}", true)
        }
    }
}

fun criteriaFromLines(text: String): List<TaskAcceptanceCriterion> = text.splitToSequence('\n')
    .map { it.trim() }.filter { it.isNotEmpty() }.mapIndexed { index, line ->
        TaskAcceptanceCriterion("c${index + 1}", line, "manual")
    }.toList()

fun taskIsTerminal(status: String): Boolean = status in setOf("completed", "failed", "timeout", "killed")
enum class StatusTone { Neutral, Live, Good, Bad }
fun taskStatusTone(status: String): StatusTone = when (status) {
    "running" -> StatusTone.Live
    "completed" -> StatusTone.Good
    "failed", "timeout", "killed" -> StatusTone.Bad
    else -> StatusTone.Neutral
}
fun taskRowSubtitle(task: TaskWire, now: Long, fmt: (Long, Long) -> String): String =
    "${task.agentId} · ${task.executor}${task.executorTarget?.takeIf { it.isNotEmpty() }?.let { "/$it" }.orEmpty()} · ${fmt(task.createdAt, now)}"
fun defaultTaskAgent(options: List<TaskAgentOption>): String? = options.firstOrNull { it.enabled }?.id
fun delegateGoalFromComposer(text: String): String? = text.trim().takeIf { it.isNotEmpty() }
fun statusFilterOptions(): List<SelectOption> = listOf(
    SelectOption("", "All"), SelectOption("queued", "Queued"), SelectOption("running", "Running"),
    SelectOption("awaiting-input", "Awaiting input"), SelectOption("completed", "Completed"), SelectOption("failed", "Failed"),
)
