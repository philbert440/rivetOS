package io.rivethub.app.plane

enum class AttachmentStatus { UPLOADING, READY, FAILED }

data class PendingAttachment(
    val id: String,
    val name: String,
    val status: AttachmentStatus,
    val uri: String? = null,
    val mime: String? = null,
)

data class StagedTurnAttachment(
    val mime: String,
    val pathOrUri: String,
    val name: String? = null,
)

fun readyAttachments(atts: List<PendingAttachment>): List<StagedTurnAttachment> =
    atts.mapNotNull { a ->
        val uri = a.uri
        if (a.status != AttachmentStatus.READY || uri.isNullOrBlank()) null
        else StagedTurnAttachment(mime = a.mime ?: "application/octet-stream", pathOrUri = uri, name = a.name)
    }

fun anyFailed(atts: List<PendingAttachment>): Boolean =
    atts.any { it.status == AttachmentStatus.FAILED }

/** Guess an image mime from a file name when the provider omitted one. */
fun mimeFromName(name: String, fallback: String? = null): String? =
    when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> fallback
    }

fun anyUploading(atts: List<PendingAttachment>): Boolean =
    atts.any { it.status == AttachmentStatus.UPLOADING }

/**
 * Uploads go to the session's node (its denUrl), never the entry/view node.
 * Staging on the wrong node yields a uri the session's harness cannot read.
 */
fun uploadBaseUrl(sessionNodeDenUrl: String, entryUrl: String = ""): String {
    val session = sessionNodeDenUrl.trimEnd('/')
    if (session.isNotBlank()) return session
    return entryUrl.trimEnd('/')
}

/**
 * A uri interpolated into `[attached: …]` must not be able to leave the
 * bracket line: control chars split it and `]` closes it early. Percent-
 * encode the closers, strip the controls. Matches rivethub-web sanitizeUri.
 */
fun sanitizeUri(uri: String): String =
    uri.replace(Regex("[\\u0000-\\u001f\\u007f]"), "").replace("]", "%5D")

/**
 * Message text with `[attached: …]` reference lines for staged files.
 * Callers pass already-ready uris (uploading/failed chips never belong here).
 */
fun withAttachmentText(text: String, uris: List<String>): String {
    val lines = uris.filter { it.isNotBlank() }.map { "[attached: ${sanitizeUri(it)}]" }
    if (lines.isEmpty()) return text
    return if (text.isEmpty()) lines.joinToString("\n") else text + "\n" + lines.joinToString("\n")
}

fun readyUris(atts: List<PendingAttachment>): List<String> =
    atts.mapNotNull { a -> a.uri.takeIf { a.status == AttachmentStatus.READY && !it.isNullOrBlank() } }

/** den-server `MAX_UPLOAD_BYTES` (1 GiB). Unknown size (`size < 0`) is not refused here. */
const val MAX_UPLOAD_BYTES: Long = 1024L * 1024L * 1024L

fun uploadTooLarge(size: Long): Boolean = size >= 0 && size > MAX_UPLOAD_BYTES
