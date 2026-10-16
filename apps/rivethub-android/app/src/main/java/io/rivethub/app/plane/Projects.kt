package io.rivethub.app.plane

import io.rivethub.app.gateway.HubProject

/**
 * Projects on the phone: the same projects desktop shows as canvas spaces,
 * shared through hub state (data/HubStateRepository.kt). A session sits in
 * at most one project; the rest stay in the dated list below.
 */
data class ProjectsState(
    val projects: List<HubProject> = emptyList(),
    /** Session key → project id. Key order is oldest → newest. */
    val membership: Map<String, String> = emptyMap(),
    val defaultProjectId: String = "",
)

/** Same cap as the document's text fields. */
const val PROJECT_NAME_MAX = 200

private fun cleanName(name: String): String = name.trim().take(PROJECT_NAME_MAX).trim()

/** Projects in drawer order: `order`, then oldest first. */
fun orderedProjects(projects: List<HubProject>): List<HubProject> =
    projects.sortedWith(compareBy<HubProject> { it.order }.thenBy { it.createdAt })

/** Add a project at the end. A blank name changes nothing. */
fun addProject(state: ProjectsState, name: String, id: String, nowMs: Long): ProjectsState {
    val clean = cleanName(name)
    if (clean.isEmpty() || id.isBlank() || state.projects.any { it.id == id }) return state
    val order = (state.projects.maxOfOrNull { it.order } ?: -1.0) + 1.0
    return state.copy(projects = state.projects + HubProject(id, clean, order, nowMs))
}

fun renameProject(state: ProjectsState, id: String, name: String): ProjectsState {
    val clean = cleanName(name)
    if (clean.isEmpty() || state.projects.none { it.id == id }) return state
    return state.copy(projects = state.projects.map { if (it.id == id) it.copy(name = clean) else it })
}

/** Remove a project. Its sessions go back to the dated list; nothing on the den changes. */
fun deleteProject(state: ProjectsState, id: String): ProjectsState {
    if (state.projects.none { it.id == id }) return state
    return ProjectsState(
        projects = state.projects.filter { it.id != id },
        membership = state.membership.filterValues { it != id },
        defaultProjectId = state.defaultProjectId.takeIf { it != id }.orEmpty(),
    )
}

/**
 * Put [key] in [projectId], or take it out of any project when [projectId]
 * is null. An unknown project changes nothing. Placing moves the key to the
 * newest end, matching desktop's recency order.
 */
fun placeInProject(state: ProjectsState, key: String, projectId: String?): ProjectsState {
    if (key.isBlank()) return state
    if (projectId == null) {
        return if (key in state.membership) state.copy(membership = state.membership - key) else state
    }
    if (state.projects.none { it.id == projectId }) return state
    return state.copy(membership = state.membership - key + (key to projectId))
}

/** The project a row is in. A row is matched by its key, then its session id. */
fun projectOf(item: ChatItem, membership: Map<String, String>, projectIds: Set<String>): String? {
    val id = membership[item.key] ?: item.sessionId?.let { membership[it] }
    return id?.takeIf { it in projectIds }
}

data class ProjectSection(
    val project: HubProject,
    val rows: List<LocatedChatItem>,
    /** Rows whose session is running right now (the green dot). */
    val running: Int,
)

/** One section per project, in drawer order, holding its live rows in the order given. */
fun projectSections(
    projects: List<HubProject>,
    membership: Map<String, String>,
    live: List<LocatedChatItem>,
): List<ProjectSection> {
    val ids = projects.map { it.id }.toSet()
    val byProject = live.groupBy { projectOf(it.item, membership, ids) }
    return orderedProjects(projects).map { project ->
        val rows = byProject[project.id].orEmpty()
        ProjectSection(project, rows, rows.count { isActiveStatus(it.item.status) })
    }
}

/** Live rows that are in no project: what the dated sections show. */
fun rowsOutsideProjects(
    live: List<LocatedChatItem>,
    projects: List<HubProject>,
    membership: Map<String, String>,
): List<LocatedChatItem> {
    val ids = projects.map { it.id }.toSet()
    if (ids.isEmpty()) return live
    return live.filter { projectOf(it.item, membership, ids) == null }
}

/**
 * The agent "+" in a project starts: the project's default agent, preferring
 * the copy on the project's default node and an online one. Null when the
 * project names no agent (or it is gone): the caller asks which agent.
 */
fun projectAgent(project: HubProject, agents: List<AgentRow>): AgentRow? {
    val wanted = project.defaults?.agentId?.takeIf { it.isNotBlank() } ?: return null
    val node = project.defaults.node.orEmpty()
    return agents.filter { it.agentId == wanted }
        .sortedWith(compareByDescending<AgentRow> { node.isNotBlank() && it.node == node }.thenByDescending { it.online })
        .firstOrNull()
}

/** A new session opened for [project]: its directory, and its model/effort when set. */
fun openInProject(open: AgentOpen, project: HubProject): AgentOpen {
    val d = project.defaults ?: return open
    return open.copy(
        directory = d.directory?.takeIf { it.startsWith("/") } ?: open.directory,
        model = d.model?.takeIf { it.isNotBlank() } ?: open.model,
        effort = d.effort?.takeIf { it.isNotBlank() } ?: open.effort,
    )
}
