package io.rivethub.app.plane

// Attachment image rules that do not need Android: how far to downsample a
// decode, and how the process-wide bitmap cache is keyed.

/**
 * Largest side a decoded attachment bitmap may have. Android's GPU texture
 * limit (and so the hardware-bitmap limit) is 4096 on older devices and 8192
 * or more on newer ones; 4096 is safe everywhere and is already twice the
 * full-screen viewer's 2048 target.
 */
const val MAX_DECODE_DIM: Int = 4096

/** Largest decoded pixel count: 4 MP, which is 16 MiB at ARGB_8888. */
const val MAX_DECODE_PIXELS: Long = 4L * 1024L * 1024L

/**
 * Sources beyond this on either side are refused rather than sampled (JPEG
 * and WebP cannot exceed it anyway; a larger PNG is a decode bomb, not a chat
 * attachment).
 */
const val MAX_SOURCE_DIM: Int = 65_535

/** Sources beyond this many pixels (256 MP) are refused rather than sampled. */
const val MAX_SOURCE_PIXELS: Long = 1L shl 28

private const val MAX_SAMPLE: Long = 1L shl 16

/**
 * The power-of-two `inSampleSize` for decoding a [srcW]×[srcH] image for a
 * [targetPx] view, or null when the source should not be decoded at all
 * (non-positive or absurd bounds, or bounds that no sample can satisfy).
 *
 * First the view rule: sample down while the shorter side stays ≥
 * [targetPx]. Then the memory rule, which always wins: keep doubling until
 * the sampled image has at most [maxPixels] pixels AND its longer side is at
 * most [maxDim]. Sampled sides are rounded up (decoders round down or up by
 * format, so this is the conservative side). All arithmetic is Long.
 */
fun sampleSizeFor(
    srcW: Int,
    srcH: Int,
    targetPx: Int,
    maxPixels: Long = MAX_DECODE_PIXELS,
    maxDim: Int = MAX_DECODE_DIM,
): Int? {
    if (srcW <= 0 || srcH <= 0 || maxPixels <= 0L || maxDim <= 0) return null
    if (srcW > MAX_SOURCE_DIM || srcH > MAX_SOURCE_DIM) return null
    val w = srcW.toLong()
    val h = srcH.toLong()
    if (w * h > MAX_SOURCE_PIXELS) return null
    val target = targetPx.coerceAtLeast(1).toLong()
    var s = 1L
    while (s < MAX_SAMPLE && w / (s * 2) >= target && h / (s * 2) >= target) s *= 2
    while (true) {
        val sw = (w + s - 1) / s
        val sh = (h + s - 1) / s
        if (sw * sh <= maxPixels && maxOf(sw, sh) <= maxDim.toLong()) return s.toInt()
        if (s >= MAX_SAMPLE) return null
        s *= 2
    }
}

/**
 * The namespace an attachment uri is resolved in: the session node's origin
 * (scheme + host + port, lowercased) plus the device identity generation, so
 * the same relative path on two nodes, or after a re-enrolment, never shares a
 * cached bitmap.
 */
fun imageSourceNamespace(nodeBaseUrl: String, identityGen: Int): String {
    val base = nodeBaseUrl.trim().trimEnd('/')
    return (originOf(base) ?: base.lowercase()) + "#g" + identityGen
}

/**
 * The process-wide bitmap cache key. The namespace is length-prefixed so no
 * choice of namespace, size and uri can collide with another.
 */
fun imageCacheKey(namespace: String, targetPx: Int, uri: String): String =
    "${namespace.length}:$namespace|$targetPx|$uri"
