package io.rivethub.app.plane

enum class AttachmentStatus { UPLOADING, READY, FAILED }

data class PendingAttachment(
    val id: String,
    val name: String,
    val status: AttachmentStatus,
    val uri: String? = null,
)

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
