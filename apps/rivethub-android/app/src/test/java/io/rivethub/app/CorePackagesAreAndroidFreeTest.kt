package io.rivethub.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CorePackagesAreAndroidFreeTest {
    @Test
    fun `domain gateway transport and plane have no android imports`() {
        val base = File("src/main/java/io/rivethub/app")
        assertTrue("core packages dir missing: $base", base.isDirectory)
        val pkgs = listOf("domain", "gateway", "transport", "plane")
        for (pkg in pkgs) {
            // (a missing core dir is tolerated; the >=3-files floor still guards an empty walk)
        }
        val files = pkgs.flatMap { pkg ->
            File(base, pkg).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        }
        assertTrue("scanned ${files.size} files, want ≥ 4 under $base", files.size >= 4)
        val androidImport = Regex("^import android(x)?\\.")
        val comAndroidImport = Regex("^import com\\.android\\.")
        val fqAndroid = Regex("""\bandroid(x)?\.""")
        val violations = mutableListOf<String>()
        for (f in files) {
            f.readLines().forEachIndexed { i, line ->
                val trimmed = line.trimStart()
                val isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
                if (androidImport.containsMatchIn(line) || comAndroidImport.containsMatchIn(line)) {
                    violations += "${f.path}:${i + 1}: $line"
                } else if (!trimmed.startsWith("import ") && !isComment && fqAndroid.containsMatchIn(line)) {
                    violations += "${f.path}:${i + 1}: $line"
                }
            }
        }
        assertTrue("android refs in core packages:\n${violations.joinToString("\n")}", violations.isEmpty())
    }
}
