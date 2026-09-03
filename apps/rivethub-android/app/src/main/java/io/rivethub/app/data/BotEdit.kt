package io.rivethub.app.data

import io.rivethub.app.domain.BlobShape
import io.rivethub.app.domain.Bot
import io.rivethub.app.domain.BotLook
import io.rivethub.app.domain.BotLooks
import kotlinx.serialization.Serializable

/**
 * Local personalization for one bot. Null fields keep the identity default
 * (pretty agent name, [BotLooks.forAgent]). Not a wire type.
 */
@Serializable
data class BotEdit(
    val name: String? = null,
    val color: Long? = null,
    val shape: String? = null,
)

/** Name + face after applying a [BotEdit]. */
data class EffectiveBot(
    val displayName: String,
    val look: BotLook,
)

/** Cosmetic only — does not change [Bot.id] or [Bot.defaultSessionId]. */
fun Bot.effective(edit: BotEdit?): EffectiveBot {
    val base = BotLooks.forAgent(agent)
    val name = edit?.name?.trim()?.takeIf { it.isNotEmpty() }
    val shape = BlobShape.fromName(edit?.shape)
    return EffectiveBot(
        displayName = name ?: displayName,
        look = BotLook(color = edit?.color ?: base.color, shape = shape ?: base.shape),
    )
}
