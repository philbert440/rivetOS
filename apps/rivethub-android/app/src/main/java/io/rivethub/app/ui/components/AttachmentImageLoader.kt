package io.rivethub.app.ui.components

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import io.rivethub.app.plane.imageCacheKey
import io.rivethub.app.plane.sampleSizeFor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Attachment image loading without an image library: the bytes come from the
 * chat VM (a local content uri for a file this device uploaded, else the
 * device mTLS client against the session's node), are decoded here with
 * [BitmapFactory] off the main thread, downsampled per `plane.sampleSizeFor`
 * (bounded pixels and sides), and kept in a small process-wide LRU keyed by
 * `plane.imageCacheKey` (source namespace + size + uri).
 */
@Immutable
sealed interface AttachmentImage {
    data object Loading : AttachmentImage
    data class Ready(val bitmap: ImageBitmap) : AttachmentImage
    data object Unavailable : AttachmentImage
}

/**
 * Where attachment bytes come from: [load] resolves a uri inside [namespace]
 * (the session node origin + identity generation), which also scopes the
 * bitmap cache so two nodes serving the same path never share an image.
 */
@Immutable
class AttachmentImageSource(
    val namespace: String,
    val load: suspend (String) -> ByteArray?,
)

private object AttachmentImageCache {
    private const val MAX_BYTES = 24 * 1024 * 1024
    private val lru = object : LruCache<String, ImageBitmap>(MAX_BYTES) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.width * value.height * 4
    }

    fun get(key: String): ImageBitmap? = lru.get(key)
    fun put(key: String, value: ImageBitmap) {
        lru.put(key, value)
    }
}

/**
 * The image for [uri] from [source], decoded for about [targetPx] on its
 * shorter side. Loads once per (namespace, size, uri) while in composition —
 * no retry loop; a null from the source or an undecodable body is
 * [AttachmentImage.Unavailable].
 *
 * The state holder is created under `key(cacheKey)`, so a new uri, size or
 * namespace at the same composition position starts from a fresh state
 * (the cached bitmap for THAT key, else Loading) instead of inheriting the
 * previous key's Ready bitmap. Leaving composition cancels the producer,
 * which cancels the fetch; the CancellationException is rethrown, not
 * turned into Unavailable.
 */
@Composable
fun rememberAttachmentImage(
    uri: String,
    targetPx: Int,
    source: AttachmentImageSource,
): AttachmentImage {
    val cacheKey = imageCacheKey(source.namespace, targetPx, uri)
    return key(cacheKey) {
        produceState<AttachmentImage>(
            initialValue = AttachmentImageCache.get(cacheKey)?.let { AttachmentImage.Ready(it) } ?: AttachmentImage.Loading,
            key1 = cacheKey,
            key2 = source,
        ) {
            val cached = AttachmentImageCache.get(cacheKey)
            if (cached != null) {
                value = AttachmentImage.Ready(cached)
                return@produceState
            }
            // Under key(cacheKey) a Ready value can only be this key's bitmap.
            if (value is AttachmentImage.Ready) return@produceState
            value = AttachmentImage.Loading
            val bytes = try {
                source.load(uri)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            val bitmap = bytes?.let { withContext(Dispatchers.Default) { decodeSampled(it, targetPx) } }
            value = if (bitmap == null) {
                AttachmentImage.Unavailable
            } else {
                AttachmentImageCache.put(cacheKey, bitmap)
                AttachmentImage.Ready(bitmap)
            }
        }.value
    }
}

/**
 * Decode with the power-of-two sample from `plane.sampleSizeFor`: the shorter
 * side stays ≥ [targetPx] where memory allows, but the result never exceeds
 * MAX_DECODE_PIXELS or MAX_DECODE_DIM. Null (→ pill) for absurd bounds.
 */
private fun decodeSampled(bytes: ByteArray, targetPx: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val sample = sampleSizeFor(bounds.outWidth, bounds.outHeight, targetPx) ?: return@runCatching null
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}.getOrNull()
