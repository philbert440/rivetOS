package io.rivethub.app

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Clean-room guard (UX program 2026-09-24). Builders implement the chat and
// terminal UX from docs/UX-SPEC.md only. The retired client is AGPL, so these
// lineage substrings must not appear in sources or Gradle coordinates.
class NoAgplLineageTest {
    private val TOKENS = listOf(
        "rikkahub",
        "me.rerere",
        "dev.rivet.app",
        "hugeicons",
        "jlatexmath",
        "highlight_",
        "UIMessagePart",
        "MessageNode",
        "com.github.rikkahub",
    )

    private val sourceRoots = listOf(
        File("src/main/java"),
        File("src/main/res"),
        File("src/test/java"),
    )

    // Paths are relative to the app module, same as NoPollingTest.
    private val gradleFiles = listOf(
        File("../gradle/libs.versions.toml"),
        File("build.gradle.kts"),
        File("../settings.gradle.kts"),
    )

    @Test
    fun sources_have_no_agpl_lineage_tokens() {
        for (root in sourceRoots) {
            assertTrue("missing ${root.path}", root.isDirectory)
        }
        // This file lists TOKENS, so a hit here would be the guard itself.
        val self = File("src/test/java/io/rivethub/app/NoAgplLineageTest.kt")
        assertTrue("missing ${self.path}", self.isFile)
        val selfCanon = self.canonicalFile
        val files = sourceRoots.flatMap { root ->
            root.walkTopDown().filter { file ->
                file.isFile &&
                    (file.extension.equals("kt", ignoreCase = true) ||
                        file.extension.equals("xml", ignoreCase = true)) &&
                    file.canonicalFile != selfCanon
            }.toList()
        }
        assertFalse(
            "walk included ${self.path}",
            files.any { it.canonicalFile == selfCanon },
        )
        assertTrue(
            "walked ${files.size} source files, want at least 50",
            files.size >= 50,
        )
        assertNoLineageTokens(files)
    }

    @Test
    fun dependencies_have_no_agpl_lineage_coordinates() {
        for (file in gradleFiles) {
            assertTrue("missing ${file.path}", file.isFile)
        }
        assertNoLineageTokens(gradleFiles)
    }

    private fun assertNoLineageTokens(files: List<File>) {
        assertTrue("TOKENS is empty", TOKENS.isNotEmpty())
        for (file in files) {
            file.readLines().forEachIndexed { index, line ->
                for (token in TOKENS) {
                    assertFalse(
                        "${file.path}:${index + 1} contains $token",
                        line.contains(token, ignoreCase = true),
                    )
                }
            }
        }
    }
}
