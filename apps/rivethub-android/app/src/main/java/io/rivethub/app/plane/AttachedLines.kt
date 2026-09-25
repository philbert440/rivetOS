package io.rivethub.app.plane

/**
 * Attachment references inside a user turn (UX-SPEC §1.3). Attachments are
 * sent as trailing `[attached: <uri>]` lines ([withAttachmentText]); the
 * transcript shows them as chips under the bubble, never as text.
 */
data class AttachedRef(
    val uri: String,
    val name: String,
    val isImage: Boolean,
)

private val ATTACHED_LINE = Regex("""^\[attached: (.*\S.*)]$""")

/**
 * Split a user turn into its body and its trailing attachment references, in
 * send order. Only the trailing run of well-formed lines is taken (trailing
 * blank lines are skipped); a malformed or mid-text line stays in the body.
 * A turn that is nothing but references yields a blank body.
 */
fun splitAttachedLines(text: String): Pair<String, List<AttachedRef>> {
    if (text.isEmpty()) return "" to emptyList()
    val lines = text.split('\n')
    var end = lines.size
    val refs = ArrayList<AttachedRef>()
    var bodyEnd = end
    while (end > 0) {
        val line = lines[end - 1].trimEnd('\r').trim()
        if (line.isEmpty()) {
            end--
            continue
        }
        val m = ATTACHED_LINE.find(line) ?: break
        val uri = m.groupValues[1].trim()
        val name = attachedDisplayName(uri)
        refs += AttachedRef(uri = uri, name = name, isImage = mimeFromName(name)?.startsWith("image/") == true)
        end--
        bodyEnd = end
    }
    if (refs.isEmpty()) return text to emptyList()
    val body = lines.subList(0, bodyEnd).joinToString("\n").trimEnd()
    return body to refs.asReversed().toList()
}

/**
 * The chip label for an attachment uri: the last path segment, without a
 * query or fragment, with percent escapes decoded (the sender encodes `]`).
 * Falls back to the whole uri when there is no usable segment.
 */
fun attachedDisplayName(uri: String): String {
    val path = uri.substringBefore('#').substringBefore('?').trimEnd('/', '\\')
    val seg = path.substringAfterLast('/').substringAfterLast('\\')
    val name = percentDecode(seg).trim()
    return name.ifBlank { uri.trim() }
}

/** Decode `%XX` escapes as UTF-8; a malformed escape is kept literally. */
internal fun percentDecode(s: String): String {
    if ('%' !in s) return s
    val out = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '%' && i + 2 < s.length) {
            val hi = Character.digit(s[i + 1], 16)
            val lo = Character.digit(s[i + 2], 16)
            if (hi >= 0 && lo >= 0) {
                out.write(hi * 16 + lo)
                i += 3
                continue
            }
        }
        out.write(c.toString().toByteArray(Charsets.UTF_8))
        i++
    }
    return out.toString(Charsets.UTF_8.name())
}

/**
 * Where an attachment thumbnail can be fetched with the device's mTLS client,
 * or null when it cannot. The den stages uploads as node-local paths and
 * serves no GET for them, so a bare filesystem path is not fetchable. An
 * absolute `https` uri is used only when it points at the session's own node
 * (the client certificate is never presented to another origin); a
 * root-relative `/api/` path is resolved against that node.
 */
fun attachmentFetchUrl(uri: String, nodeBaseUrl: String): String? {
    val u = uri.trim()
    val base = nodeBaseUrl.trim().trimEnd('/')
    if (base.isEmpty() || u.isEmpty()) return null
    if (u.split('/', '?', '#').any { it == ".." }) return null
    if (u.startsWith("https://", ignoreCase = true)) {
        return u.takeIf { originOf(it) != null && originOf(it) == originOf(base) }
    }
    if (u.startsWith("/api/")) return base + u
    return null
}

internal fun originOf(url: String): String? {
    val schemeEnd = url.indexOf("://")
    if (schemeEnd <= 0) return null
    val rest = url.substring(schemeEnd + 3)
    val host = rest.substringBefore('/').substringBefore('?').substringBefore('#')
    if (host.isEmpty() || '@' in host) return null
    return url.substring(0, schemeEnd).lowercase() + "://" + host.lowercase()
}
