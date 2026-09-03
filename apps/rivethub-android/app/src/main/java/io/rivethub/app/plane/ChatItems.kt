package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessCapabilities
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.LegacyHarnessSession
import io.rivethub.app.gateway.denRoomKey
import io.rivethub.app.gateway.nativeIdOf
import java.time.Instant
import java.time.OffsetDateTime

/** How a conversation row is driven — mirrors rivethub-web ChatItemKind. */
enum class ChatItemKind { DRAFT, HARNESS, LEGACY }

data class ChatItem(
    val key: String,
    val kind: ChatItemKind,
    val title: String,
    val sessionId: String? = null,
    val harnessId: String? = null,
    val command: String? = null,
    val model: String? = null,
    val status: String? = null,
    val updatedAt: Long = 0,
    val pin: Boolean = false,
)

/** Den roster tokens per harness id — UI/spawn labels, never key material. */
val ROSTER_COMMAND: Map<String, String> = mapOf(
    "claude-code" to "claude",
    "grok-build" to "grok",
    "kimi-code" to "kimi",
    "hermes" to "hermes",
    "deepseek-harness" to "dsh",
)

fun rosterCommandFor(harnessId: String?): String? = harnessId?.let { ROSTER_COMMAND[it] }

data class HarnessGate(
    val bound: Boolean,
    val stream: Boolean,
    val canInterrupt: Boolean,
    val canApprove: Boolean,
    val canResume: Boolean,
)

val CLOSED_GATE = HarnessGate(
    bound = false,
    stream = false,
    canInterrupt = false,
    canApprove = false,
    canResume = false,
)

/**
 * Union plane sessions with the legacy on-disk scan, keyed by NATIVE id.
 * Plane wins. A failing driver ([Result] failure) does not blank the list —
 * its rows drop out and the legacy scan still backs them.
 */
fun chatItems(
    planeRows: Map<String, Result<List<HarnessSessionSummary>>>,
    legacyRows: List<LegacyHarnessSession>,
    drafts: List<String> = emptyList(),
    draftCreatedAt: Map<String, Long> = emptyMap(),
): List<ChatItem> {
    val harnessSessions = planeRows.values.flatMap { it.getOrDefault(emptyList()) }
    val legacyByKey = legacyRows.associateBy { it.id }
    val items = LinkedHashMap<String, ChatItem>()

    for (summary in harnessSessions) {
        val native = nativeIdOf(summary.sessionId) ?: continue
        val legacy = legacyByKey[native]
        val parsed = parseIsoMillis(summary.updatedAt)
        items[native] = ChatItem(
            key = summary.sessionId,
            kind = ChatItemKind.HARNESS,
            title = summary.title?.takeIf { it.isNotBlank() } ?: legacy?.title?.takeIf { it.isNotBlank() } ?: native,
            sessionId = summary.sessionId,
            harnessId = summary.harnessId,
            command = legacy?.command?.takeIf { it.isNotBlank() } ?: ROSTER_COMMAND[summary.harnessId],
            model = summary.model,
            status = summary.status,
            updatedAt = if (parsed != 0L) parsed else (legacy?.updatedAt ?: 0L),
        )
    }

    for (row in legacyRows) {
        if (items.containsKey(row.id)) continue
        items[row.id] = ChatItem(
            key = row.id,
            kind = ChatItemKind.LEGACY,
            title = row.title,
            command = row.command,
            updatedAt = row.updatedAt,
        )
    }

    val draftItems = drafts.filter { it !in items }.map { id ->
        ChatItem(
            key = id,
            kind = ChatItemKind.DRAFT,
            title = "new conversation",
            updatedAt = draftCreatedAt[id] ?: 0L,
        )
    }
    return sortByRecency(items.values.toList() + draftItems)
}

/**
 * Newest-first, pins mingled in ONE recency order (desktop 0.5.14). Pins
 * that are not already in [items] are appended as extra rows with `pin=true`.
 * A matching existing row is enriched (model / harnessId) and keeps `pin`
 * unset — `pin` means "synthesized pin row; hide discard". Draft rows whose
 * key is a pin are dropped so the pin supplies title/updatedAt. Stable on ties.
 */
fun sortByRecency(items: List<ChatItem>, pins: List<ChatItem> = emptyList()): List<ChatItem> {
    if (pins.isEmpty()) return items.sortedByDescending { it.updatedAt }
    val pinKeys = pins.map { it.key }.toHashSet()
    val pinByKey = pins.associateBy { it.key }
    val withoutAgentDrafts = items.filter { !(it.kind == ChatItemKind.DRAFT && it.key in pinKeys) }
    val enriched = withoutAgentDrafts.map { item ->
        val pin = pinByKey[item.key] ?: return@map item
        item.copy(
            model = item.model ?: pin.model,
            harnessId = item.harnessId ?: pin.harnessId,
        )
    }
    val existing = enriched.map { it.key }.toHashSet()
    val extra = pins.filter { it.key !in existing }.map { it.copy(pin = true) }
    return (extra + enriched).sortedByDescending { it.updatedAt }
}

fun findChatItem(items: List<ChatItem>, key: String?): ChatItem? {
    if (key == null) return null
    items.find { it.key == key }?.let { return it }
    val native = denRoomKey(key)
    return items.find { it.key != key && denRoomKey(it.key) == native }
}

fun harnessGate(
    item: ChatItem?,
    descriptors: List<HarnessDescriptor>?,
): HarnessGate {
    if (item == null || item.kind != ChatItemKind.HARNESS || item.harnessId.isNullOrBlank() || item.sessionId.isNullOrBlank()) {
        return CLOSED_GATE
    }
    val caps: HarnessCapabilities = descriptors?.find { it.harnessId == item.harnessId }?.capabilities
        ?: return CLOSED_GATE
    return HarnessGate(
        bound = true,
        stream = caps.liveStream,
        canInterrupt = caps.interrupt,
        canApprove = caps.approvals,
        canResume = caps.resume,
    )
}

fun listableHarnesses(descriptors: List<HarnessDescriptor>?): List<String> =
    (descriptors ?: emptyList()).filter { it.capabilities.listSessions }.map { it.harnessId }

fun parseIsoMillis(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }
        .getOrDefault(0L)
