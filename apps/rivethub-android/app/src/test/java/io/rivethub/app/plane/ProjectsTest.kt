package io.rivethub.app.plane

import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.HubProjectDefaults
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ProjectsTest {
    private val work = HubProject("p1", "Work", 0.0, 10)
    private val home = HubProject("p2", "Home", 1.0, 20)
    private val state = ProjectsState(listOf(work, home), mapOf("claude-code:a" to "p1"), "p1")

    private fun row(key: String, status: String = "idle") =
        LocatedChatItem(ChatItem(key, ChatItemKind.HARNESS, key, sessionId = key, status = status), "n", "n", "https://n")

    private fun agent(id: String, node: String, online: Boolean = true) =
        AgentRow(id, id, "claude-code", node, node, "https://$node", null, node = node, online = online)

    @Test
    fun `adding appends after the highest order and ignores blank names`() {
        val next = addProject(state, "  Side  ", "p3", 99)
        assertEquals(HubProject("p3", "Side", 2.0, 99), next.projects.last())
        assertSame(state, addProject(state, "   ", "p4", 1))
        assertSame(state, addProject(state, "dup", "p1", 1))
    }

    @Test
    fun `renaming trims and ignores unknown ids`() {
        assertEquals("Day job", renameProject(state, "p1", " Day job ").projects.first().name)
        assertSame(state, renameProject(state, "nope", "x"))
        assertSame(state, renameProject(state, "p1", " "))
    }

    @Test
    fun `deleting drops its sessions back to the list and clears the default`() {
        val next = deleteProject(state, "p1")
        assertEquals(listOf(home), next.projects)
        assertEquals(emptyMap<String, String>(), next.membership)
        assertEquals("", next.defaultProjectId)
    }

    @Test
    fun `placing moves a session between projects or out of all of them`() {
        val moved = placeInProject(state, "claude-code:a", "p2")
        assertEquals(mapOf("claude-code:a" to "p2"), moved.membership)
        assertEquals(emptyMap<String, String>(), placeInProject(moved, "claude-code:a", null).membership)
        assertSame(state, placeInProject(state, "claude-code:a", "missing"))
    }

    @Test
    fun `sections group live rows by project and count the running ones`() {
        val live = listOf(row("claude-code:a", "running"), row("codex:b"), row("claude-code:c"))
        val membership = mapOf("claude-code:a" to "p1", "claude-code:c" to "p1", "codex:x" to "gone")
        val sections = projectSections(listOf(home, work), membership, live)
        assertEquals(listOf("p1", "p2"), sections.map { it.project.id })
        assertEquals(listOf("claude-code:a", "claude-code:c"), sections[0].rows.map { it.item.key })
        assertEquals(1, sections[0].running)
        assertEquals(emptyList<LocatedChatItem>(), sections[1].rows)
        assertEquals(listOf("codex:b"), rowsOutsideProjects(live, listOf(work, home), membership).map { it.item.key })
    }

    @Test
    fun `a project's agent prefers its node, then an online copy`() {
        val project = work.copy(defaults = HubProjectDefaults(agentId = "rivet", node = "pixel"))
        val agents = listOf(agent("rivet", "arctic"), agent("rivet", "pixel", online = false), agent("other", "pixel"))
        assertEquals("pixel", projectAgent(project, agents)?.node)
        assertEquals("arctic", projectAgent(project.copy(defaults = HubProjectDefaults(agentId = "rivet")), agents)?.node)
        assertNull(projectAgent(work, agents))
    }

    @Test
    fun `a session opened in a project takes its directory and model`() {
        val open = AgentOpen("draft1", "https://arctic", "claude-code", draft = true, pinMoved = false, model = "base")
        val project = work.copy(defaults = HubProjectDefaults(directory = "/srv/app", model = "opus", effort = "high"))
        val inProject = openInProject(open, project)
        assertEquals("/srv/app", inProject.directory)
        assertEquals("opus", inProject.model)
        assertEquals("high", inProject.effort)
        assertEquals(open, openInProject(open, work))
    }
}
