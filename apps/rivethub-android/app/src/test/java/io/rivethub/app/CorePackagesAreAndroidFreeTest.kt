package io.rivethub.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CorePackagesAreAndroidFreeTest {
    @Test
    fun `domain gateway and transport have no android imports`() {
        val relative = File("src/main/java/io/rivethub/app")
        val base = if (relative.isDirectory) relative else File(System.getProperty("user.dir"), "src/main/java/io/rivethub/app")
        val files = listOf("domain", "gateway", "transport").flatMap { pkg ->
            File(base, pkg).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        }
        assertTrue("scanned ${files.size} files, want ≥ 3 under $base", files.size >= 3)
        val androidImport = Regex("^import android(x)?\\.")
        val comAndroidImport = Regex("^import com\\.android\\.")
        val violations = mutableListOf<String>()
        for (f in files) {
            f.readLines().forEachIndexed { i, line ->
                if (androidImport.containsMatchIn(line) || comAndroidImport.containsMatchIn(line)) {
                    violations += "${f.path}:${i + 1}: $line"
                }
            }
        }
        assertTrue("android imports in core packages:\n${violations.joinToString("\n")}", violations.isEmpty())
    }
}
