package io.rivethub.app.plane

import io.rivethub.app.gateway.AgentUpdateRequest
import java.util.Locale

/**
 * Agent long-press actions (2026-09-04, Phil: Edit + Go-to-node next to the
 * existing pointer semantics). The action sheet UI iterates
 * [agentSheetActions] so the order lives here, not in the composable.
 * Edit is omitted when [online] is false: an unmatched preset has an empty
 * den URL, and saving it reports that the node refused the update.
 */
enum class AgentSheetAction { StartOver, New, Edit, GoToNode }

fun agentSheetActions(online: Boolean = true): List<AgentSheetAction> = buildList {
    add(AgentSheetAction.StartOver)
    add(AgentSheetAction.New)
    if (online) add(AgentSheetAction.Edit)
    add(AgentSheetAction.GoToNode)
}

/** The edit sheet's form values (web agents-section.tsx AgentEditor). */
data class AgentEditFields(
    val name: String = "",
    val color: String = "",
    val model: String = "",
    val effort: String = "",
    val systemPrompt: String = "",
    /** Absolute cwd. Blank is omitted; node is not editable from this form. */
    val directory: String = "",
    /** Shared-directory link. Sent only when it differs from [AgentRow.sharedLink]. */
    val sharedLink: Boolean = true,
)

/** Slug cap copied from the agent-registry rule the web editor uses. */
const val AGENT_SLUG_MAX = 48

/**
 * Working-directory slug: lowercase, non-alnum runs become `-`, trim `-`,
 * cap at [AGENT_SLUG_MAX]. Empty becomes `agent`.
 */
fun agentSlug(name: String): String {
    val slug = name.lowercase(Locale.ROOT)
        .replace(Regex("[^a-z0-9]+"), "-")
        .trim('-')
        .take(AGENT_SLUG_MAX)
        .trim('-')
    return slug.ifEmpty { "agent" }
}

/**
 * Placeholder `directoryRoot/slug`. No root yet yields empty so the sheet
 * can show its generic hint string instead.
 */
fun agentDirectoryPlaceholder(directoryRoot: String?, name: String): String {
    val root = directoryRoot?.trim()?.trimEnd('/')?.trimEnd('\\').orEmpty()
    if (root.isEmpty()) return ""
    return "$root/${agentSlug(name)}"
}

/**
 * Fields → the den PATCH shape. Blank name/color/model/effort/prompt become
 * null and drop out of the JSON (`wireJson` omits nulls). [directory] is
 * sent only when trimmed, non-blank, and different from [original].
 * [AgentEditFields.sharedLink] is sent only when it changed. `nodeBaseUrl`
 * is never sent — the node is immutable — and `harnessId` stays out so a
 * null cannot clear it server-side.
 */
fun agentPatchRequest(fields: AgentEditFields, original: AgentRow): AgentUpdateRequest {
    val directory = fields.directory.trim().let { trimmed ->
        trimmed.takeIf { it.isNotEmpty() && it != original.directory.trim() }
    }
    return AgentUpdateRequest(
        name = fields.name.trim().takeIf { it.isNotEmpty() },
        color = fields.color.trim().takeIf { it.isNotEmpty() },
        model = fields.model.trim().takeIf { it.isNotEmpty() },
        effort = fields.effort.trim().takeIf { it.isNotEmpty() },
        systemPrompt = fields.systemPrompt.trim().takeIf { it.isNotEmpty() },
        directory = directory,
        sharedLink = fields.sharedLink.takeIf { it != original.sharedLink },
    )
}

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
