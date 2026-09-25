package io.rivethub.app.plane

import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.gateway.TaskWire
import org.junit.Assert.*
import org.junit.Test

class TasksTest {
    @Test fun `task ids require the exact UUID wire shape`() {
        assertTrue(isTaskId("12345678-1234-4234-8234-123456789abc"))
        assertTrue(isTaskId("ABCDEF01-ABCD-0000-FFFF-0123456789AB"))
        listOf("", "task", "1-1-1-1-1", "12345678123442348234123456789abc",
            "12345678-1234-4234-8234-123456789abg", "12345678-1234-4234-8234-123456789abc/wait",
            " 12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abc\n"
        ).forEach { assertFalse(it, isTaskId(it)) }
    }

    @Test fun `catalog orders locals then mesh then presets and deduplicates by id`() {
        val options = taskAgentOptions(listOf(
            CatalogAgent("reviewer", kind = "preset", name = "Reviewer", harnessId = "claude-code", node = "den-a"),
            CatalogAgent("remote", node = "den-b"),
            CatalogAgent("local", local = true, model = "model-a"),
            CatalogAgent("local", node = "den-b"),
            CatalogAgent("reviewer", kind = "preset"),
            CatalogAgent("codex-preset", kind = "preset", name = "Codex", harnessId = "codex", node = "den-a", implemented = false, gap = "Needs a headless runner"),
        ))
        assertEquals(listOf("local", "remote", "reviewer", "codex-preset"), options.map { it.id })
        assertEquals("local (model-a) · this node", options[0].label)
        assertEquals("remote @ den-b", options[1].label)
        assertEquals("Reviewer (agent · claude-code @ den-a)", options[2].label)
        assertTrue(options[2].enabled)
        assertFalse(options[3].enabled)
        assertEquals("Needs a headless runner", options[3].helper)
        assertEquals("local", defaultTaskAgent(options))
        assertNull(defaultTaskAgent(options.takeLast(1)))
        assertNull(defaultTaskAgent(emptyList()))
        val ids = listOf("claude", "grok", "grok-fast", "hermes", "local", "unknown")
        val labels = listOf("Claude Code", "grok Build", "grok Build (fast)", "Hermes", "local", "unknown")
        assertEquals(labels.map { "$it (model) · this node" },
            taskAgentOptions(ids.map { CatalogAgent(it, local = true, model = "model") }).map { it.label })
        assertEquals(labels.map { "$it @ den-b" },
            taskAgentOptions(ids.map { CatalogAgent(it, node = "den-b") }).map { it.label })
    }

    @Test fun `criteria trim drop blanks and number surviving lines`() {
        assertEquals(listOf("c1", "c2"), criteriaFromLines("  tests pass\r\n\n docs updated \n").map { it.id })
        assertEquals(listOf("tests pass", "docs updated"), criteriaFromLines("  tests pass\n\n docs updated").map { it.description })
        assertTrue(criteriaFromLines("x\ny").all { it.kind == "manual" })
        assertTrue(criteriaFromLines(" \n\t").isEmpty())
        assertEquals(listOf("a\rb"), criteriaFromLines("a\rb").map { it.description })
    }

    @Test fun `status tones and terminal states match task actions`() {
        listOf("queued", "awaiting-input", "unknown").forEach {
            assertEquals(StatusTone.Neutral, taskStatusTone(it)); assertFalse(taskIsTerminal(it))
        }
        assertEquals(StatusTone.Live, taskStatusTone("running"))
        assertFalse(taskIsTerminal("running"))
        assertEquals(StatusTone.Good, taskStatusTone("completed"))
        assertTrue(taskIsTerminal("completed"))
        listOf("failed", "timeout", "killed").forEach {
            assertEquals(StatusTone.Bad, taskStatusTone(it)); assertTrue(taskIsTerminal(it))
        }
    }

    @Test fun `subtitle formats creation time and optional executor target`() {
        val task = TaskWire(agentId = "reviewer", executor = "harness-session", executorTarget = "claude-code", createdAt = 10)
        assertEquals("reviewer · harness-session/claude-code · elapsed 90", taskRowSubtitle(task, 100) { created, now -> "elapsed ${now - created}" })
        assertEquals("reviewer · harness-session · recent", taskRowSubtitle(task.copy(executorTarget = null), 100) { _, _ -> "recent" })
    }

    @Test fun `delegation requires trimmed text and Tasks is always a standalone destination`() {
        assertNull(delegateGoalFromComposer(" \n"))
        assertEquals("Do work", delegateGoalFromComposer(" Do work\n"))
        assertTrue(drawerDestEnabled(DrawerDest.Tasks))
        assertTrue(drawerDestVisible(DrawerDest.Tasks))
        assertTrue(drawerOpensTasksScreen(DrawerDest.Tasks))
        assertFalse(drawerOpensTasksScreen(DrawerDest.Memory))
        assertNull(drawerTabRoute(DrawerDest.Tasks))
        assertEquals(listOf("", "queued", "running", "awaiting-input", "completed", "failed"), statusFilterOptions().map { it.value })
    }
}
