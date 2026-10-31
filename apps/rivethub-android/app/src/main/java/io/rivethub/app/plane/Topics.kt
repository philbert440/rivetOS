package io.rivethub.app.plane

import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.TopicSession
import io.rivethub.app.gateway.TopicSummary
import io.rivethub.app.gateway.nativeIdOf

/**
 * Topics in the drawer (UX-SPEC §2): rh's work topics replace the projects
 * hub state used to carry, so the phone and RivetHub desktop file sessions in
 * the same place. rh keeps topics and placements on the memory database; the
 * drawer's project sections render them through the [HubProject] shape
 * (plane/Projects.kt), with no defaults. A gateway without topics keeps the
 * hub-state projects.
 */

/** Separator between a nested topic and its parents in its drawer name. */
const val TOPIC_PATH_SEP = " › "

/** A closed topic shows again once one of its sessions is active after it closed (note 36). */
fun topicOpen(topic: TopicSummary): Boolean {
    val closed = topic.closedAt ?: return true
    return (topic.lastActive ?: 0L) > closed
}

/**
 * Open work topics as drawer sections: each root, newest activity first,
 * followed by its subtopics in the same order, a nested one named by its
 * path. A closed topic hides its subtree with it.
 */
fun drawerTopics(topics: List<TopicSummary>): List<HubProject> {
    val work = topics.filter { it.kind == "work" }
    val ids = work.map { it.id }.toSet()
    val children = work.groupBy { it.parent?.takeIf { p -> p in ids } }
    val recency = compareByDescending<TopicSummary> { it.lastActive ?: it.updatedAt }.thenBy { it.name.lowercase() }
    val out = ArrayList<HubProject>()
    fun walk(parent: String?, path: String, depth: Int) {
        if (depth > 4) return
        for (t in children[parent].orEmpty().sortedWith(recency)) {
            if (!topicOpen(t)) continue
            val name = if (path.isEmpty()) t.name else path + TOPIC_PATH_SEP + t.name
            out += HubProject(id = t.id, name = name, order = out.size.toDouble(), createdAt = t.createdAt)
            walk(t.id, name, depth + 1)
        }
    }
    walk(null, "", 1)
    return out
}

/** Session key → topic id, under both the canonical and the native id (rows match either). */
fun topicMembership(filing: List<TopicSession>, topicIds: Set<String>): Map<String, String> {
    val out = HashMap<String, String>()
    for (s in filing) {
        if (s.topicId !in topicIds) continue
        out[s.sessionId] = s.topicId
        nativeIdOf(s.sessionId)?.let { out.putIfAbsent(it, s.topicId) }
    }
    return out
}

/** One placement to send: the local [key] it came from, the canonical [session] and its topic. */
data class PlacementWork(val key: String, val session: String, val topicId: String)

/** What to do with the phone's pending placements now. */
data class PlacementPlan(val send: List<PlacementWork>, val drop: Set<String>)

/**
 * Pending placements (a draft started in a topic, or a migrated project's
 * session) wait until the key names a real session. [canonicalOf] gives that
 * session's canonical id, or null while it is still a draft. A pending entry
 * for a topic that is gone, or one rh already shows, is dropped.
 */
fun planPlacements(
    pending: Map<String, String>,
    canonicalOf: (String) -> String?,
    topicIds: Set<String>,
    placed: Map<String, String>,
): PlacementPlan {
    val send = ArrayList<PlacementWork>()
    val drop = HashSet<String>()
    for ((key, topic) in pending) {
        if (topic !in topicIds) {
            drop += key
            continue
        }
        val session = canonicalOf(key) ?: continue
        if (placed[session] == topic) drop += key else send += PlacementWork(key, session, topic)
    }
    return PlacementPlan(send, drop)
}

/** Move hub-state projects to topics: the project ids an existing topic already answers, and the projects to create. */
data class ProjectMigration(val reuse: Map<String, String>, val create: List<HubProject>)

/** A project whose name matches a work topic (case-insensitive) joins it; any other becomes a new topic. */
fun planProjectMigration(projects: List<HubProject>, topics: List<TopicSummary>): ProjectMigration {
    val byName = topics.filter { it.kind == "work" }.associateBy { it.name.trim().lowercase() }
    val reuse = HashMap<String, String>()
    val create = ArrayList<HubProject>()
    for (p in orderedProjects(projects)) {
        val hit = byName[p.name.trim().lowercase()]
        if (hit != null) reuse[p.id] = hit.id else if (p.name.isNotBlank()) create += p
    }
    return ProjectMigration(reuse, create)
}

/** The migrated projects' sessions as pending placements: key → topic id, through [topicOf] (project id → topic id). */
fun migratedPlacements(membership: Map<String, String>, topicOf: Map<String, String>): Map<String, String> =
    membership.mapNotNull { (key, project) -> topicOf[project]?.let { key to it } }.toMap()
