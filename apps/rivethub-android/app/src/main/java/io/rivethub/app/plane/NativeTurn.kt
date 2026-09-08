package io.rivethub.app.plane

import io.rivethub.app.gateway.UserTurn
import io.rivethub.app.gateway.UserTurnAttachment

/**
 * Caption vs `[attached: uri]` lines. Protocol image turns keep the caption
 * bare — the staged files ride [UserTurn.attachments]. Every other session
 * still interpolates reference lines because PTY drivers reject attachments.
 */
fun composerSendText(
    caption: String,
    atts: List<PendingAttachment>,
    nativeImages: Boolean,
): String {
    val trimmed = caption.trim()
    val staged = readyAttachments(atts)
    if (nativeImages && staged.isNotEmpty() && staged.all { isNativeImageMime(it.mime) }) {
        return trimmed
    }
    return withAttachmentText(trimmed, readyUris(atts))
}

fun nativeImageTurn(atts: List<StagedTurnAttachment>, nativeImages: Boolean): Boolean =
    nativeImages && atts.isNotEmpty() && atts.all { isNativeImageMime(it.mime) }

/** Optimistic bubble for an image-only native turn. */
fun optimisticUserText(text: String, attachments: List<StagedTurnAttachment>): String {
    if (text.isNotBlank()) return text
    if (attachments.isEmpty()) return ""
    return attachments.joinToString("\n") { "[Image]" }
}

fun buildUserTurn(
    text: String,
    attachments: List<StagedTurnAttachment>,
    sheet: HarnessSheet?,
    transport: String?,
    model: String?,
    effort: String?,
): UserTurn {
    val protocol = transport == "protocol"
    val turnOptions = protocol && sheet?.turnOptions == true
    val nativeAtts = nativeImageTurn(attachments, nativeImageAttachments(sheet, transport))
    return UserTurn(
        text = text,
        model = model?.trim()?.takeIf { it.isNotEmpty() && turnOptions },
        effort = effort?.trim()?.takeIf { it.isNotEmpty() && turnOptions },
        attachments = if (nativeAtts) {
            attachments.map { UserTurnAttachment(it.mime, it.pathOrUri, it.name) }
        } else {
            null
        },
    )
}
