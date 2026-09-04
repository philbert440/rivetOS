package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentUpdateRequest

/**
 * Agent long-press actions (2026-09-04, Phil: Edit + Go-to-node next to the
 * existing pointer semantics). The action sheet UI iterates
 * [agentSheetActions] so the order lives here, not in the composable.
 */
enum class AgentSheetAction { StartOver, New, Edit, GoToNode }

fun agentSheetActions(): List<AgentSheetAction> = listOf(
    AgentSheetAction.StartOver,
    AgentSheetAction.New,
    AgentSheetAction.Edit,
    AgentSheetAction.GoToNode,
)

/** The edit sheet's form values (web agents-section.tsx AgentEditor). */
data class AgentEditFields(
    val name: String = "",
    val color: String = "",
    val model: String = "",
    val effort: String = "",
    val systemPrompt: String = "",
    /** New target node; "" means "unchanged" and is omitted from the PATCH. */
    val nodeBaseUrl: String = "",
)

/**
 * Fields → the den PATCH shape. Blank values become null and drop out of the
 * JSON (`wireJson` omits nulls), so the wire only carries what the form
 * actually sets. The harness is deliberately NOT patchable here — the task's
 * field list omits a harness picker, and leaving `harnessId` out of the body
 * avoids the explicit-nulls problem (`harnessId: null` CLEARS it server-side).
 */
fun agentPatchRequest(fields: AgentEditFields): AgentUpdateRequest = AgentUpdateRequest(
    name = fields.name.trim().takeIf { it.isNotEmpty() },
    color = fields.color.trim().takeIf { it.isNotEmpty() },
    model = fields.model.trim().takeIf { it.isNotEmpty() },
    effort = fields.effort.trim().takeIf { it.isNotEmpty() },
    systemPrompt = fields.systemPrompt.trim().takeIf { it.isNotEmpty() },
    nodeBaseUrl = fields.nodeBaseUrl.trim().trimEnd('/').takeIf { it.isNotEmpty() },
)

/**
 * The web editor's color gate (`agents-section.tsx` save-disabled regex):
 * empty (inherit) or `#rgb` / `#rrggbb`.
 */
fun agentColorValid(color: String): Boolean {
    val c = color.trim()
    if (c.isEmpty()) return true
    if (!c.startsWith("#")) return false
    val hex = c.removePrefix("#")
    return (hex.length == 3 || hex.length == 6) && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
}

/**
 * Model options for the edit sheet (web `modelOptionsFor` + the editor's
 * unshift-current-if-unlisted). value+label pairs — the UI maps them to its
 * own SelectOption. An empty sheet yields just the current value, so a saved
 * but unlisted model stays visible and round-trips.
 */
fun agentModelOptions(sheet: HarnessSheet?, current: String): List<Pair<String, String>> {
    val base = sheet?.models.orEmpty().map { it.id to it.label }
    val cur = current.trim()
    return if (cur.isNotEmpty() && base.none { it.first == cur }) listOf(cur to cur) + base else base
}

/** Effort options for [model] (web `effortOptionsFor` + unshift-current). */
fun agentEffortOptions(sheet: HarnessSheet?, model: String, current: String): List<Pair<String, String>> {
    val base = effortListFor(sheet, model).map { it.id to it.label }
    val cur = current.trim()
    return if (cur.isNotEmpty() && base.none { it.first == cur }) listOf(cur to cur) + base else base
}

/**
 * Go-to-node guard: `HubViewModel.selectViewNode` TOGGLES the filter off when
 * the node is already selected, which would make "Go to node" leave the node
 * the agent lives on. Returns the node to select, or null when the gesture
 * should be a no-op (already viewing it, or the row has no node).
 */
fun agentGoToNodeId(currentViewNodeId: String, rowNodeId: String): String? =
    if (rowNodeId.isBlank() || currentViewNodeId == rowNodeId) null else rowNodeId
