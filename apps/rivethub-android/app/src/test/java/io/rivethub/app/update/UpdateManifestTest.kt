package io.rivethub.app.update

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestTest {
    private fun good(
        version: String = "0.5.1",
        versionCode: Int = 5001,
        file: String = "RivetHub-0.5.1.apk",
        sha256: String = "a".repeat(64),
        sizeBytes: Long = 112000000,
    ) = buildJsonObject {
        put("version", version)
        put("versionCode", versionCode)
        put("file", file)
        put("sha256", sha256)
        put("sizeBytes", sizeBytes)
    }

    /** Pure ordering fixtures: built directly, bypassing the feed-side code/version rule. */
    private fun entry(version: String, versionCode: Int) =
        AndroidManifestEntry(version, versionCode, "RivetHub-$version.apk", "a".repeat(64), 1)

    @Test fun `accepts a well-formed entry`() {
        val e = validateManifestEntry(good(), "android")
        assertEquals("0.5.1", e.version)
        assertEquals(5001, e.versionCode)
        assertEquals("RivetHub-0.5.1.apk", e.file)
        assertEquals("a".repeat(64), e.sha256)
        assertEquals(112000000L, e.sizeBytes)
    }

    @Test fun `refuses traversal and separators in file`() {
        for (file in listOf(
            "../elsewhere/payload.apk",
            "a/../b.apk",
            "dir/payload.apk",
            "dir\\payload.apk",
            "..",
            ".hidden.apk",
            "name/../payload.apk",
        )) {
            try {
                validateManifestEntry(good(file = file), "android")
                throw AssertionError("expected throw for file=$file")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("basename"))
            }
        }
    }

    @Test fun `refuses malformed versions and digests`() {
        try {
            validateManifestEntry(good(version = "v1.2.3"), "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("semver"))
        }
        try {
            validateManifestEntry(good(version = "1.2"), "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("semver"))
        }
        try {
            validateManifestEntry(good(sha256 = "A".repeat(64)), "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("sha256"))
        }
        try {
            validateManifestEntry(good(sha256 = "a".repeat(63)), "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("sha256"))
        }
    }

    @Test fun `refuses missing or non-object entries`() {
        for (raw in listOf(null, JsonNull, JsonPrimitive("x"), JsonPrimitive(42), JsonArray(emptyList()))) {
            try {
                validateManifestEntry(raw, "android")
                throw AssertionError("expected throw for $raw")
            } catch (e: IllegalArgumentException) {
                assertTrue(e.message!!.contains("no entry"))
            }
        }
    }

    @Test fun `refuses missing or non-positive versionCode`() {
        val missing = buildJsonObject {
            put("version", "0.5.1")
            put("file", "RivetHub-0.5.1.apk")
            put("sha256", "a".repeat(64))
            put("sizeBytes", 12)
        }
        try {
            validateManifestEntry(missing, "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("versionCode"))
        }
        try {
            validateManifestEntry(good(versionCode = 0), "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("versionCode"))
        }
        val asString = buildJsonObject {
            put("version", "0.5.1")
            put("versionCode", "5022")
            put("file", "RivetHub-0.5.1.apk")
            put("sha256", "a".repeat(64))
            put("sizeBytes", 12)
        }
        try {
            validateManifestEntry(asString, "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("versionCode"))
        }
    }

    @Test fun `refuses missing or non-positive sizeBytes`() {
        val missing = buildJsonObject {
            put("version", "0.5.1")
            put("versionCode", 5001)
            put("file", "RivetHub-0.5.1.apk")
            put("sha256", "a".repeat(64))
        }
        try {
            validateManifestEntry(missing, "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("sizeBytes"))
        }
        val fractional = buildJsonObject {
            put("version", "0.5.1")
            put("versionCode", 5001)
            put("file", "RivetHub-0.5.1.apk")
            put("sha256", "a".repeat(64))
            put("sizeBytes", 1.5)
        }
        try {
            validateManifestEntry(fractional, "android")
            throw AssertionError("expected throw")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("sizeBytes"))
        }
    }

    @Test fun `compares numeric triples`() {
        assertTrue(newerVersion("0.5.1", "0.5.0"))
        assertFalse(newerVersion("0.5.0", "0.5.1"))
        assertTrue(newerVersion("1.0.0", "0.9.9"))
        assertFalse(newerVersion("0.5.0", "0.5.0"))
        assertTrue(newerVersion("0.10.0", "0.9.0"))
    }

    @Test fun `ranks a release above its own prereleases`() {
        assertTrue(newerVersion("1.0.0", "1.0.0-beta"))
        assertFalse(newerVersion("1.0.0-beta", "1.0.0"))
        assertTrue(newerVersion("1.0.0-beta.2", "1.0.0-beta.1"))
        assertTrue(newerVersion("1.0.0-rc", "1.0.0-beta"))
        assertTrue(newerVersion("1.0.0-beta.10", "1.0.0-beta.9"))
    }

    @Test fun `ignores build metadata and fails closed on non-semver`() {
        assertTrue(newerVersion("1.0.1+build5", "1.0.0"))
        assertFalse(newerVersion("v1.2.3", "1.0.0"))
        assertFalse(newerVersion("1.2", "1.0.0"))
        assertFalse(newerVersion("1.0.0", "junk"))
    }

    @Test fun `isNewer is versionCode-first`() {
        val highCode = entry(version = "0.4.0", versionCode = 5023)
        assertTrue(isNewer(highCode, 5022, "0.5.22"))
        val lowCode = entry(version = "9.0.0", versionCode = 5000)
        assertFalse(isNewer(lowCode, 5022, "0.5.22"))
        val same = entry(version = "0.5.22", versionCode = 5022)
        assertFalse(isNewer(same, 5022, "0.5.22"))
        assertFalse(isNewer(same, 5022, "0.5.22-debug"))
    }

    @Test fun `isNewer uses semver as a tie-breaker`() {
        val bump = entry(version = "0.5.23", versionCode = 5022)
        assertTrue(isNewer(bump, 5022, "0.5.22"))
        val olderName = entry(version = "0.5.21", versionCode = 5022)
        assertFalse(isNewer(olderName, 5022, "0.5.22"))
    }

    @Test fun `versionCodeFor 0_5_22 is 5022`() {
        assertEquals(5022, versionCodeFor("0.5.22"))
    }

    @Test fun `versionCodeFor 1_0_0 is 1_000_000`() {
        assertEquals(1_000_000, versionCodeFor("1.0.0"))
    }

    @Test fun `versionCodeFor 0_6_0 is 6000`() {
        assertEquals(6000, versionCodeFor("0.6.0"))
    }

    @Test fun `versionCodeFor ignores prerelease suffix`() {
        assertEquals(1_000_000, versionCodeFor("1.0.0-beta.1"))
        assertEquals(5022, versionCodeFor("0.5.22-debug"))
        assertEquals(6000, versionCodeFor("0.6.0+build.9"))
    }

    @Test fun `parseAndroidEntry is null when android key is absent`() {
        assertNull(parseAndroidEntry("""{"linux":{"version":"0.5.1","file":"x","sha256":"${"a".repeat(64)}"}}"""))
        assertNull(parseAndroidEntry("""{"android":null}"""))
        val parsed = parseAndroidEntry(
            """{"android":{"version":"0.5.22","versionCode":5022,"file":"RivetHub-0.5.22.apk","sha256":"${"b".repeat(64)}","sizeBytes":12}}""",
        )!!
        assertEquals(5022, parsed.versionCode)
        assertEquals("0.5.22", parsed.version)
    }

    @Test fun `validateManifestEntry refuses a versionCode that breaks the rule`() {
        val bad = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"version":"0.5.22","versionCode":99000000,"file":"RivetHub-0.5.22.apk","sha256":"${"a".repeat(64)}","sizeBytes":10}""",
        )
        val err = runCatching { validateManifestEntry(bad, "android") }.exceptionOrNull()
        assertTrue(err?.message?.contains("does not match version") == true)
        val good = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"version":"0.5.22","versionCode":5022,"file":"RivetHub-0.5.22.apk","sha256":"${"a".repeat(64)}","sizeBytes":10}""",
        )
        assertEquals(5022, validateManifestEntry(good, "android").versionCode)
    }
}
