package io.rivethub.app.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * D2-11 guard: Material 3 stays the plumbing host (MaterialTheme, ModalNavigationDrawer,
 * ModalBottomSheet, SwipeToDismissBox, Snackbar, pull-to-refresh, DropdownMenu, Text,
 * minimumInteractiveComponentSize, drawable-backed Icon) but no Material CHROME may
 * creep back into `ui/` — every surface is a Rivet component over `RivetColors` tokens.
 */
class MaterialResidueTest {
    private val forbiddenImports = listOf(
        "androidx.compose.material.icons",
        "androidx.compose.material3.TopAppBar",
        "androidx.compose.material3.ListItem",
        "androidx.compose.material3.Card",
        "androidx.compose.material3.ElevatedCard",
        "androidx.compose.material3.OutlinedTextField",
        "androidx.compose.material3.FloatingActionButton",
        "androidx.compose.material3.CircularProgressIndicator",
        "androidx.compose.material3.LinearProgressIndicator",
        "androidx.compose.material3.TextButton",
        "androidx.compose.material3.AlertDialog",
        "androidx.compose.material3.Button",
        "androidx.compose.material3.Divider",
        "androidx.compose.material3.HorizontalDivider",
    )

    @Test
    fun `ui sources import no forbidden Material chrome`() {
        val base = File("src/main/java/io/rivethub/app/ui")
        assertTrue("ui dir missing: $base", base.isDirectory)
        val files = base.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("scanned ${files.size} ui files, want ≥ 10", files.size >= 10)
        val violations = mutableListOf<String>()
        for (f in files) {
            f.readLines().forEachIndexed { i, line ->
                val t = line.trim()
                if (!t.startsWith("import ")) return@forEachIndexed
                val path = t.removePrefix("import ").trim()
                for (forbidden in forbiddenImports) {
                    if (path == forbidden || path.startsWith("$forbidden.")) {
                        violations += "${f.path}:${i + 1}: $t"
                    }
                }
            }
        }
        assertTrue(
            "Material chrome in ui/ (replace with Rivet components):\n${violations.joinToString("\n")}",
            violations.isEmpty(),
        )
    }
}
