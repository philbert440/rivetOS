package io.rivethub.app.plane

import org.junit.Assert.assertEquals
import org.junit.Test

class ToolTitlesTest {
    @Test
    fun `normalize strips emoji prefixes from stream content`() {
        assertEquals("shell", normalizeToolName("🔧 shell"))
        assertEquals("Bash", normalizeToolName("✅ Bash"))
    }

    @Test
    fun `titles Claude Bash with description or command`() {
        assertEquals("Ran: list files", humanToolTitle("Bash", mapOf("description" to "list files")))
        assertEquals("Ran: ls -la", humanToolTitle("Bash", mapOf("command" to "ls -la")))
        assertEquals("Ran a command", humanToolTitle("Bash"))
    }

    @Test
    fun `titles Claude file tools with basename`() {
        assertEquals("Read foo.ts", humanToolTitle("Read", mapOf("file_path" to "/a/b/foo.ts")))
        assertEquals("Edited bar.tsx", humanToolTitle("Edit", mapOf("file_path" to "/x/y/bar.tsx")))
        assertEquals("Wrote z.md", humanToolTitle("Write", mapOf("file_path" to "z.md")))
    }

    @Test
    fun `titles Grok tools`() {
        assertEquals("Ran: pwd", humanToolTitle("run_terminal_command", mapOf("command" to "pwd")))
        assertEquals("Read a.txt", humanToolTitle("read_file", mapOf("path" to "/tmp/a.txt")))
        assertEquals("Edited x.ts", humanToolTitle("search_replace", mapOf("path" to "src/x.ts")))
        assertEquals("Searched web: rivetos", humanToolTitle("web_search", mapOf("query" to "rivetos")))
        assertEquals("Asked a question", humanToolTitle("ask_user_question"))
    }

    @Test
    fun `falls back sanely for unknown tools`() {
        assertEquals("my custom tool", humanToolTitle("my_custom_tool"))
        assertEquals("memory search", humanToolTitle("mcp:rivetos:memory_search"))
    }

    @Test
    fun `mcp double-underscore names use the last segment`() {
        assertEquals("bar", humanToolTitle("mcp__foo__bar"))
        assertEquals("memory search", humanToolTitle("mcp__rivetos__memory_search"))
    }
}
