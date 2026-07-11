package dev.rivet.app.di

import kotlinx.serialization.json.Json
import dev.rivet.highlight.Highlighter
import dev.rivet.app.AppScope
import dev.rivet.app.data.ai.AILoggingManager
import dev.rivet.app.data.ai.tools.LocalTools
import dev.rivet.app.data.event.AppEventBus
import dev.rivet.app.service.ChatService
import dev.rivet.app.utils.EmojiData
import dev.rivet.app.utils.EmojiUtils
import dev.rivet.app.utils.JsonInstant
import dev.rivet.app.utils.SoundEffectPlayer
import dev.rivet.app.web.WebServerManager
import dev.rivet.tts.provider.TTSManager
import org.koin.dsl.module

val appModule = module {
    single<Json> { JsonInstant }

    single {
        Highlighter(get())
    }

    single {
        AppEventBus()
    }

    single {
        LocalTools(get(), get())
    }


    single {
        AppScope()
    }

    single<EmojiData> {
        EmojiUtils.loadEmoji(get())
    }

    single {
        TTSManager(get())
    }

    single {
        SoundEffectPlayer(get())
    }

    single {
        AILoggingManager()
    }

    single {
        ChatService(
            context = get(),
            appScope = get(),
            settingsStore = get(),
            conversationRepo = get(),
            memoryRepository = get(),
            generationHandler = get(),
            templateTransformer = get(),
            providerManager = get(),
            localTools = get(),
            mcpManager = get(),
            filesManager = get(),
            skillManager = get()
        )
    }

    single {
        WebServerManager(
            context = get(),
            appScope = get(),
            chatService = get(),
            conversationRepo = get(),
            settingsStore = get(),
            filesManager = get()
        )
    }
}
