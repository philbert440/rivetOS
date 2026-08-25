package dev.rivetos.bots.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import dev.rivetos.bots.data.BotEdit
import dev.rivetos.bots.data.EffectiveBot
import dev.rivetos.bots.data.effective
import dev.rivetos.bots.domain.Bot

/** Device-local name/look overrides, provided from [Prefs.botEdits] at the App root. */
val LocalBotEdits = compositionLocalOf { emptyMap<String, BotEdit>() }

@Composable
fun rememberEffective(bot: Bot): EffectiveBot {
    val edit = LocalBotEdits.current[bot.id]
    return remember(bot.id, bot.agent, edit) { bot.effective(edit) }
}
