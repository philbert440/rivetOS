package io.rivethub.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import io.rivethub.app.data.BotEdit
import io.rivethub.app.data.EffectiveBot
import io.rivethub.app.data.effective
import io.rivethub.app.domain.Bot

/** Device-local name/look overrides, provided from [Prefs.botEdits] at the App root. */
val LocalBotEdits = compositionLocalOf { emptyMap<String, BotEdit>() }

@Composable
fun rememberEffective(bot: Bot): EffectiveBot {
    val edit = LocalBotEdits.current[bot.id]
    return remember(bot.id, bot.agent, edit) { bot.effective(edit) }
}
