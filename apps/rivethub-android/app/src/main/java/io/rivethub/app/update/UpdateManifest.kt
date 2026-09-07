package io.rivethub.app.update

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Pure manifest/version logic for in-app Android updates (no Android SDK).
 * Trust root is the connected gateway: the UI never supplies a URL or digest.
 */

data class AndroidManifestEntry(
    val version: String,
    val versionCode: Int,
    val file: String,
    val sha256: String,
    val sizeBytes: Long,
)

const val MANIFEST_PATH = "builds/rivethub/latest.json"
const val BUILDS_PREFIX = "builds/rivethub"

/**
 * Android `versionCode` for a version name: `major*1_000_000 + minor*1_000 + patch`.
 * Prerelease / build-metadata / AGP `-debug` suffixes are ignored.
 * Keep in sync with `app/build.gradle.kts`.
 */
fun versionCodeFor(name: String): Int {
    val core = name.substringBefore('+').substringBefore('-')
    val parts = core.split('.')
    require(parts.size == 3) { "not major.minor.patch: $name" }
    val major = parts[0].toInt()
    val minor = parts[1].toInt()
    val patch = parts[2].toInt()
    require(major >= 0 && minor >= 0 && patch >= 0) { "negative component in $name" }
    return major * 1_000_000 + minor * 1_000 + patch
}

private val VERSION_RE = Regex("""^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$""")
private val SHA256_RE = Regex("^[0-9a-f]{64}$")
/** Artifact basename fence: no separators, no dot-prefix, no traversal. */
private val FILE_RE = Regex("^[A-Za-z0-9][A-Za-z0-9._+-]*$")

private val manifestJson = Json { ignoreUnknownKeys = true }

/** Parse `latest.json`; null when the `android` key is absent (no build published). */
fun parseAndroidEntry(raw: String): AndroidManifestEntry? {
    val root = manifestJson.parseToJsonElement(raw)
    val obj = root as? JsonObject ?: throw IllegalArgumentException("manifest is not an object")
    if (!obj.containsKey("android")) return null
    val android = obj["android"]
    if (android == null || android is JsonNull) return null
    return validateManifestEntry(android, "android")
}

/** Validate one platform's manifest entry; throws with a reason. */
fun validateManifestEntry(raw: JsonElement?, platform: String): AndroidManifestEntry {
    val e = raw as? JsonObject
        ?: throw IllegalArgumentException("manifest has no entry for $platform")
    val version = e.string("version")
    if (version == null || !VERSION_RE.matches(version)) {
        throw IllegalArgumentException("manifest $platform: version is not semver")
    }
    val file = e.string("file")
    if (file == null || !FILE_RE.matches(file) || file.contains("..")) {
        throw IllegalArgumentException("manifest $platform: file is not a plain basename")
    }
    val sha256 = e.string("sha256")
    if (sha256 == null || !SHA256_RE.matches(sha256)) {
        throw IllegalArgumentException("manifest $platform: sha256 is not a hex digest")
    }
    val versionCode = e.strictPositiveInt("versionCode")
        ?: throw IllegalArgumentException("manifest $platform: versionCode is not a positive int")
    val sizeBytes = e.strictPositiveLong("sizeBytes")
        ?: throw IllegalArgumentException("manifest $platform: sizeBytes is not a positive int")
    // Feed-side guard for the same brick as a wrong local bump: a published code
    // above the rule would install once and then never see a "newer" build again.
    val expectedCode = versionCodeFor(version)
    if (versionCode != expectedCode) {
        throw IllegalArgumentException(
            "manifest $platform: versionCode $versionCode does not match version $version (expected $expectedCode)",
        )
    }
    return AndroidManifestEntry(
        version = version,
        versionCode = versionCode,
        file = file,
        sha256 = sha256,
        sizeBytes = sizeBytes,
    )
}

/**
 * Newer = [AndroidManifestEntry.versionCode] greater than [currentCode].
 * Semver compare is a tie-breaker when the codes match (display uses the
 * version string). AGP's `-debug` suffix is stripped from [currentName].
 */
fun isNewer(entry: AndroidManifestEntry, currentCode: Int, currentName: String): Boolean {
    if (entry.versionCode > currentCode) return true
    if (entry.versionCode < currentCode) return false
    return newerVersion(entry.version, currentName.removeSuffix("-debug"))
}

/**
 * Semver compare: true when [a] > [b]. Numeric triple first; a release
 * outranks any prerelease of the same triple; two prereleases compare by
 * identifier per semver §11. Build metadata is ignored. Non-semver = never
 * newer (fail closed).
 */
fun newerVersion(a: String, b: String): Boolean {
    if (!VERSION_RE.matches(a) || !VERSION_RE.matches(b)) return false
    val pa = parseSemver(a)
    val pb = parseSemver(b)
    for (i in 0 until 3) {
        if (pa.nums[i] != pb.nums[i]) return pa.nums[i] > pb.nums[i]
    }
    if (pa.pre.isEmpty() && pb.pre.isEmpty()) return false
    if (pa.pre.isEmpty()) return true
    if (pb.pre.isEmpty()) return false
    val n = maxOf(pa.pre.size, pb.pre.size)
    for (i in 0 until n) {
        val x = pa.pre.getOrNull(i) ?: return false
        val y = pb.pre.getOrNull(i) ?: return true
        if (x == y) continue
        val xn = x.all { it.isDigit() }
        val yn = y.all { it.isDigit() }
        if (xn && yn) return x.toLong() > y.toLong()
        if (xn != yn) return yn
        return x > y
    }
    return false
}

private data class ParsedSemver(val nums: List<Int>, val pre: List<String>)

private fun parseSemver(v: String): ParsedSemver {
    val noBuild = v.substringBefore('+')
    val core = noBuild.substringBefore('-')
    val prePart = if ('-' in noBuild) noBuild.substringAfter('-') else ""
    return ParsedSemver(
        nums = core.split('.').map { it.toInt() },
        pre = if (prePart.isEmpty()) emptyList() else prePart.split('.'),
    )
}

private fun JsonObject.string(key: String): String? {
    val p = this[key] as? JsonPrimitive ?: return null
    return p.contentOrNull?.takeIf { p.isString }
}

private fun JsonObject.strictPositiveInt(key: String): Int? {
    val n = strictPositiveLong(key) ?: return null
    if (n > Int.MAX_VALUE) return null
    return n.toInt()
}

private fun JsonObject.strictPositiveLong(key: String): Long? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p.isString) return null
    val content = p.content
    if ('.' in content || 'e' in content || 'E' in content) return null
    val n = content.toLongOrNull() ?: return null
    return n.takeIf { it > 0 }
}
